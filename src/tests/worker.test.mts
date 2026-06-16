import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleReport, handleRequest } from "../worker/src/index.mjs";
import { buildStatusFromRows } from "../worker/src/status.mjs";

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
      actualUrl: "https://anyrouter.top"
    })
  });

  const response = await handleReport(request, { DB: failingDb() });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "invalid_payload");
});

test("config endpoint exposes fixed AnyRouter hosts", async () => {
  const response = await handleRequest(new Request("https://api.example.test/v1/config"), {});
  const body = await response.json();
  assert.deepEqual(body.targetBaseUrlHosts, ["anyrouter.top", "a-ocnfniawgw.cn-shanghai.fcapp.run"]);
  assert.equal(body.apiBaseUrl, "https://api.example.test");
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

  const second = await handleRequest(new Request("https://api.example.test/v1/status?window=15m"), { DB: db });
  assert.equal(second.status, 200);
  assert.equal(db.calls.length, 3);

  const refreshed = await handleRequest(new Request("https://api.example.test/v1/status?window=15m&refresh=1"), { DB: db });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.headers.get("cache-control"), "no-store");
  assert.equal(db.calls.length, 6);
});

test("scheduled purge caps all retained D1 tables at 90 days", async () => {
  const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const originalNow = Date.now;
  const calls: RecordedQuery[] = [];
  const pending: Array<Promise<unknown>> = [];

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
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(calls.map((call) => call.query), [
    "DELETE FROM samples_raw WHERE created_at < ?",
    "DELETE FROM error_observations WHERE minute < ?",
    "DELETE FROM model_error_observations WHERE minute < ?",
    "DELETE FROM minute_aggregates WHERE minute < ?",
    "DELETE FROM model_minute_aggregates WHERE minute < ?"
  ]);

  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - ninetyDaysMs;
  const cutoffMinute = Math.floor(cutoffMs / 60000);
  assert.equal(calls[0]!.values[0], cutoffMs);
  assert.equal(calls[1]!.values[0], cutoffMinute);
  assert.equal(calls[2]!.values[0], cutoffMinute);
  assert.equal(calls[3]!.values[0], cutoffMinute);
  assert.equal(calls[4]!.values[0], cutoffMinute);
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
  assert.equal(status.errors[0]!.type, "server_error");
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

  assert.equal(status.errors[0]!.type, "rate_limited");
  assert.deepEqual(status.errors[0]!.statusCodes, [{ code: 429, count: 3 }]);
  assert.equal(status.errors[0]!.hints[0]!.text, "API Error 429: Rate limit reached");
  assert.equal(status.modelErrors.opus[0]!.type, "rate_limited");
  assert.deepEqual(status.models[0]!.buckets.at(-1)!.errors[0]!.statusCodes, [{ code: 429, count: 3 }]);
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

  assert.equal(status.timeline!.bucketCount, 18);
  assert.equal(status.timeline!.bucketMinutes, 5);
  assert.equal(status.models.length, 4);
  assert.equal(status.models[0]!.modelClass, "opus");
  assert.equal(status.models[0]!.buckets.at(-1)!.state, "failure");
  assert.equal(status.models[0]!.buckets.at(-1)!.errors[0]!.type, "server_error");
  assert.equal(status.models[1]!.modelClass, "sonnet");
  assert.equal(status.models[1]!.buckets.at(-2)!.state, "success");
  assert.equal(status.models[1]!.buckets.at(-1)!.state, "mixed");
  assert.equal(status.modelErrors.sonnet[0]!.type, "server_error");
  assert.equal(status.models[2]!.modelClass, "haiku");
  assert.equal(status.models[2]!.buckets.at(-1)!.state, "empty");
  assert.equal(status.models[3]!.modelClass, "unknown");
});

function failingDb() {
  return {
    prepare() {
      throw new Error("D1 should not be used for invalid payloads");
    }
  };
}

interface RecordedQuery {
  query: string;
  values: unknown[];
}

function recordingDb(calls: RecordedQuery[]) {
  return {
    prepare(query: string) {
      const record: RecordedQuery = { query, values: [] };
      calls.push(record);
      const statement = {
        bind(...values: unknown[]) {
          record.values = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          return { results: [] as T[] };
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
  const calls: string[] = [];
  return {
    calls,
    prepare(query: string) {
      calls.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          return { results: [] as T[] };
        },
        async run() {
          return {};
        }
      };
      return statement;
    }
  };
}
