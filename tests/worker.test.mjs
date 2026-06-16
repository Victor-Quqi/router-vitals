import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleReport, handleRequest } from "../worker/src/index.mjs";
import { buildStatusFromRows } from "../worker/src/status.mjs";
import { PLUGIN_VERSION, SERVER_DAILY_REPORT_HARD_LIMIT, SERVER_DAILY_REPORT_SAMPLE_RATE, SERVER_DAILY_REPORT_SOFT_LIMIT } from "../shared/policy.mjs";
test("worker rejects unknown report fields before touching D1", async () => {
    const request = new Request("https://api.example.test/v1/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            ok: true,
            errorType: "none",
            modelClass: "sonnet",
            latencyBucket: "lt_3s",
            timeBucket: 30000000,
            pluginVersion: "0.1.0",
            anonymousId: "anon_abcdefghijklmnop",
            sampleRate: 1,
            targetMatched: true,
            targetHost: "anyrouter.top",
            actualUrl: "https://anyrouter.top"
        })
    });
    const response = await handleReport(request, { DB: failingDb() });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_payload");
});
test("worker rejects reports without target host before touching D1", async () => {
    const request = new Request("https://api.example.test/v1/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            ok: true,
            errorType: "none",
            modelClass: "sonnet",
            latencyBucket: "lt_3s",
            timeBucket: 30000000,
            pluginVersion: "0.1.0",
            anonymousId: "anon_abcdefghijklmnop",
            sampleRate: 1,
            targetMatched: true
        })
    });
    const response = await handleReport(request, { DB: failingDb() });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_payload");
    assert.match(body.details.join("\n"), /missing field: targetHost/);
});
test("worker samples reports over the anonymous daily soft limit", async () => {
    const db = dailyLimitedDb(SERVER_DAILY_REPORT_SOFT_LIMIT + 1);
    const dropped = await withMathRandom(SERVER_DAILY_REPORT_SAMPLE_RATE, () => handleReport(reportRequest("anon_dailyLimitabcdefghijklmnop"), { DB: db }));
    assert.equal(dropped.status, 204);
    assert.equal(db.sampleWrites, 0);
    const accepted = await withMathRandom(SERVER_DAILY_REPORT_SAMPLE_RATE - 0.01, () => handleReport(reportRequest("anon_dailyLimitAcceptedabcdefghij"), { DB: db }));
    assert.equal(accepted.status, 200);
    assert.equal(db.sampleWrites, 1);
});
test("worker drops all reports over the anonymous daily hard limit before sample writes", async () => {
    const db = dailyLimitedDb(SERVER_DAILY_REPORT_HARD_LIMIT + 1);
    const response = await handleReport(reportRequest("anon_dailyHardLimitabcdefghijkl"), { DB: db });
    assert.equal(response.status, 204);
    assert.equal(db.sampleWrites, 0);
});
test("config endpoint exposes fixed AnyRouter hosts", async () => {
    const response = await handleRequest(new Request("https://api.example.test/v1/config"), {});
    const body = await response.json();
    assert.deepEqual(body.targetBaseUrlHosts, ["anyrouter.top", "a-ocnfniawgw.cn-shanghai.fcapp.run"]);
    assert.equal(body.apiBaseUrl, "https://api.example.test");
    assert.equal(body.latestPluginVersion, PLUGIN_VERSION);
});
test("config endpoint is also available as config.json", async () => {
    const response = await handleRequest(new Request("https://api.example.test/config.json"), {});
    const body = await response.json();
    assert.equal(body.apiBaseUrl, "https://api.example.test");
});
test("status endpoint caches reads and refresh can bypass cache", async () => {
    const db = statusDb();
    const first = await handleRequest(new Request("https://api.example.test/v1/status?window=15m"), { DB: db });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "public, max-age=20");
    assert.equal(db.calls.length, 3);
    assert.match(db.calls[0].query, /FROM target_minute_aggregates/);
    const second = await handleRequest(new Request("https://api.example.test/v1/status?window=15m"), { DB: db });
    assert.equal(second.status, 200);
    assert.equal(db.calls.length, 3);
    const refreshed = await handleRequest(new Request("https://api.example.test/v1/status?window=15m&refresh=1"), { DB: db });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.headers.get("cache-control"), "no-store");
    assert.equal(db.calls.length, 6);
});
test("status endpoint can filter by target host", async () => {
    const db = statusDb();
    const response = await handleRequest(new Request("https://api.example.test/v1/status?window=15m&targetHost=anyrouter.top&refresh=1"), { DB: db });
    assert.equal(response.status, 200);
    assert.equal(db.calls.length, 3);
    assert.match(db.calls[0].query, /target_minute_aggregates/);
    assert.match(db.calls[1].query, /target_model_minute_aggregates/);
    assert.match(db.calls[2].query, /target_model_error_observations/);
    assert.equal(db.calls[0].values[0], "anyrouter.top");
});
test("status endpoint rejects unknown target host filters", async () => {
    const response = await handleRequest(new Request("https://api.example.test/v1/status?window=15m&targetHost=api.anthropic.com"), { DB: statusDb() });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_target_host");
});
test("scheduled purge caps all retained D1 tables at 90 days", async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const originalNow = Date.now;
    const calls = [];
    const pending = [];
    Date.now = () => nowMs;
    try {
        await worker.scheduled({}, {
            DB: recordingDb(calls),
            RAW_SAMPLE_RETENTION_HOURS: 999999,
            ERROR_DETAIL_RETENTION_DAYS: 999999
        }, {
            waitUntil(promise) {
                pending.push(Promise.resolve(promise));
            }
        });
        await Promise.all(pending);
    }
    finally {
        Date.now = originalNow;
    }
    assert.deepEqual(calls.map((call) => call.query), [
        "DELETE FROM daily_report_counts WHERE updated_at < ?",
        "DELETE FROM samples_raw WHERE created_at < ?",
        "DELETE FROM target_error_observations WHERE minute < ?",
        "DELETE FROM target_model_error_observations WHERE minute < ?",
        "DELETE FROM target_minute_aggregates WHERE minute < ?",
        "DELETE FROM target_model_minute_aggregates WHERE minute < ?"
    ]);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const cutoffMs = nowMs - ninetyDaysMs;
    const cutoffMinute = Math.floor(cutoffMs / 60000);
    assert.equal(calls[0].values[0], cutoffMs);
    assert.equal(calls[1].values[0], cutoffMs);
    assert.equal(calls[2].values[0], cutoffMinute);
    assert.equal(calls[3].values[0], cutoffMinute);
    assert.equal(calls[4].values[0], cutoffMinute);
    assert.equal(calls[5].values[0], cutoffMinute);
});
test("status aggregation returns insufficient data under sample floor", () => {
    const status = buildStatusFromRows([
        {
            total_samples: 4,
            success_samples: 4,
            failure_samples: 0,
            latency_lt_3s: 4
        }
    ], "5m");
    assert.equal(status.state, "insufficient_data");
    assert.equal(status.meta.unit, "turn");
    assert.equal(status.meta.availabilityFormula, "successCount / sampleCount");
});
test("status aggregation detects unstable high error windows", () => {
    const status = buildStatusFromRows([
        {
            total_samples: 20,
            success_samples: 17,
            failure_samples: 3,
            latency_3_10s: 20,
            err_server_error: 3
        }
    ], "15m");
    assert.equal(status.state, "unstable");
    assert.equal(status.errors[0].type, "server_error");
});
test("status aggregation attaches error status codes and hints", () => {
    const status = buildStatusFromRows([
        {
            total_samples: 10,
            success_samples: 7,
            failure_samples: 3,
            err_rate_limited: 3
        }
    ], "60m", [], 30000010, [
        {
            bucket_index: 11,
            model_class: "opus",
            error_type: "rate_limited",
            status_code: 429,
            error_hint: "API Error 429: Rate limit reached",
            count: 2
        },
        {
            bucket_index: 11,
            model_class: "opus",
            error_type: "rate_limited",
            status_code: 429,
            error_hint: "Quota exceeded",
            count: 1
        }
    ]);
    assert.equal(status.errors[0].type, "rate_limited");
    assert.deepEqual(status.errors[0].statusCodes, [{ code: 429, count: 3 }]);
    assert.equal(status.errors[0].hints[0].text, "API Error 429: Rate limit reached");
    assert.equal(status.modelErrors.opus[0].type, "rate_limited");
    assert.deepEqual(status.models[0].buckets.at(-1).errors[0].statusCodes, [{ code: 429, count: 3 }]);
});
test("status aggregation builds model trend buckets", () => {
    const nowMinute = 30000010;
    const status = buildStatusFromRows([
        {
            minute: nowMinute - 1,
            total_samples: 3,
            success_samples: 2,
            failure_samples: 1,
            err_server_error: 1
        }
    ], "90m", [
        {
            minute: nowMinute - 6,
            model_class: "sonnet",
            total_samples: 2,
            success_samples: 2,
            failure_samples: 0
        },
        {
            minute: nowMinute - 1,
            model_class: "sonnet",
            total_samples: 3,
            success_samples: 2,
            failure_samples: 1
        },
        {
            minute: nowMinute,
            model_class: "opus",
            total_samples: 1,
            success_samples: 0,
            failure_samples: 1
        }
    ], nowMinute, [
        {
            bucket_index: 17,
            model_class: "opus",
            error_type: "server_error",
            status_code: 503,
            error_hint: "Service overloaded",
            count: 1
        },
        {
            bucket_index: 17,
            model_class: "sonnet",
            error_type: "server_error",
            status_code: 503,
            error_hint: "Service overloaded",
            count: 1
        }
    ]);
    assert.equal(status.timeline.bucketCount, 18);
    assert.equal(status.timeline.bucketMinutes, 5);
    assert.equal(status.models.length, 4);
    assert.equal(status.models[0].modelClass, "opus");
    assert.equal(status.models[0].buckets.at(-1).state, "failure");
    assert.equal(status.models[0].buckets.at(-1).errors[0].type, "server_error");
    assert.equal(status.models[1].modelClass, "sonnet");
    assert.equal(status.models[1].buckets.at(-2).state, "success");
    assert.equal(status.models[1].buckets.at(-1).state, "mixed");
    assert.equal(status.modelErrors.sonnet[0].type, "server_error");
    assert.equal(status.models[2].modelClass, "haiku");
    assert.equal(status.models[2].buckets.at(-1).state, "empty");
    assert.equal(status.models[3].modelClass, "unknown");
});
function failingDb() {
    return {
        prepare() {
            throw new Error("D1 should not be used for invalid payloads");
        }
    };
}
function recordingDb(calls) {
    return {
        prepare(query) {
            const record = { query, values: [] };
            calls.push(record);
            const statement = {
                bind(...values) {
                    record.values = values;
                    return statement;
                },
                async all() {
                    return { results: [] };
                },
                async run() {
                    return {};
                }
            };
            return statement;
        }
    };
}
function statusDb() {
    const calls = [];
    return {
        calls,
        prepare(query) {
            const record = { query, values: [] };
            calls.push(record);
            const statement = {
                bind(...values) {
                    record.values = values;
                    return statement;
                },
                async all() {
                    return { results: [] };
                },
                async run() {
                    return {};
                }
            };
            return statement;
        }
    };
}
function reportRequest(anonymousId) {
    return new Request("https://api.example.test/v1/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            ok: true,
            errorType: "none",
            errorStatusCode: null,
            errorHint: null,
            modelClass: "sonnet",
            latencyBucket: "lt_3s",
            timeBucket: 30000000,
            pluginVersion: "0.1.0",
            anonymousId,
            sampleRate: 1,
            targetMatched: true,
            targetHost: "anyrouter.top"
        })
    });
}
function dailyLimitedDb(count) {
    const db = {
        sampleWrites: 0,
        prepare(query) {
            const statement = {
                bind() {
                    return statement;
                },
                async all() {
                    if (query.includes("daily_report_counts"))
                        return { results: [{ count }] };
                    return { results: [] };
                },
                async run() {
                    if (query.includes("samples_raw"))
                        db.sampleWrites += 1;
                    return {};
                }
            };
            return statement;
        }
    };
    return db;
}
async function withMathRandom(value, run) {
    const original = Math.random;
    Math.random = () => value;
    try {
        return await run();
    }
    finally {
        Math.random = original;
    }
}
