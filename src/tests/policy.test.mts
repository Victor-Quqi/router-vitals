import test from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_VERSION,
  bucketAssistantStart,
  classifyError,
  classifyModel,
  createErrorHint,
  extractErrorStatusCode,
  getTodayKey,
  matchTargetBaseUrl,
  normalizeTargetHost,
  sanitizeErrorHint,
  sanitizeRemoteConfig,
  validateReportPayload
} from "../shared/policy.mjs";

test("matches only AnyRouter target hosts", () => {
  assert.equal(matchTargetBaseUrl("https://anyrouter.top/v1/messages").matched, true);
  assert.equal(matchTargetBaseUrl("https://a-ocnfniawgw.cn-shanghai.fcapp.run").matched, true);
  assert.equal(matchTargetBaseUrl("https://api.anthropic.com").matched, false);
  assert.equal(matchTargetBaseUrl("https://example.com").matched, false);
});

test("classifies current Claude model fields", () => {
  assert.equal(classifyModel({ model: "claude-opus-4-8" }, { includeEnv: false }), "opus");
  assert.equal(classifyModel({ model_id: "claude-haiku-4-5-20251001" }, { includeEnv: false }), "haiku");
  assert.equal(classifyModel({ model: { displayName: "Claude Sonnet 4" } }, { includeEnv: false }), "sonnet");
  assert.equal(classifyModel({}, { includeEnv: false }), "unknown");
});

test("remote target hosts are constrained to baked AnyRouter hosts", () => {
  const config = sanitizeRemoteConfig({
    targetBaseUrlHosts: ["anyrouter.top", "evil.example"],
    sampleRateSuccess: 2,
    sampleRateFailure: -1,
    latestPluginVersion: "9.9.9"
  });

  assert.deepEqual(config.targetBaseUrlHosts, ["anyrouter.top"]);
  assert.equal(config.sampleRateSuccess, 1);
  assert.equal(config.sampleRateFailure, 0);
  assert.equal(config.latestPluginVersion, "9.9.9");
});

test("target host normalization only accepts fixed AnyRouter hosts", () => {
  assert.equal(normalizeTargetHost("ANYROUTER.TOP"), "anyrouter.top");
  assert.equal(normalizeTargetHost("https://anyrouter.top"), null);
  assert.equal(normalizeTargetHost("api.anthropic.com"), null);
});

test("assistant start buckets are stable", () => {
  assert.equal(bucketAssistantStart(100), "lt_3s");
  assert.equal(bucketAssistantStart(3000), "3_10s");
  assert.equal(bucketAssistantStart(10000), "10_30s");
  assert.equal(bucketAssistantStart(30000), "30_60s");
  assert.equal(bucketAssistantStart(60000), "gt_60s");
  assert.equal(bucketAssistantStart(null), "unknown");
});

test("today key uses the runtime local date getters", () => {
  class LocalDateStub extends Date {
    override getFullYear(): number {
      return 2026;
    }

    override getMonth(): number {
      return 0;
    }

    override getDate(): number {
      return 1;
    }

    override toISOString(): string {
      return "2025-12-31T16:30:00.000Z";
    }
  }

  assert.equal(getTodayKey(new LocalDateStub(0)), "2026-01-01");
});

test("report payload rejects actual URLs and station fields", () => {
  const payload = {
    ok: true,
    errorType: "none",
    modelClass: "sonnet",
    assistantStartBucket: "3_10s",
    latencyBucket: "3_10s",
    timeBucket: 30000000,
    pluginVersion: "0.1.0",
    anonymousId: "anon_abcdefghijklmnop",
    sampleRate: 1,
    targetMatched: true,
    targetHost: "anyrouter.top",
    baseUrl: "https://anyrouter.top",
    stationId: "anyrouter"
  };

  const validation = validateReportPayload(payload);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unknown field: latencyBucket/);
  assert.match(validation.errors.join("\n"), /unknown field: baseUrl/);
  assert.match(validation.errors.join("\n"), /unknown field: stationId/);
});

test("report payload requires target host", () => {
  const payload = {
    ok: true,
    errorType: "none",
    modelClass: "sonnet",
    assistantStartBucket: "3_10s",
    timeBucket: 30000000,
    pluginVersion: "0.1.0",
    anonymousId: "anon_abcdefghijklmnop",
    sampleRate: 1,
    targetMatched: true
  };

  const validation = validateReportPayload(payload);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /missing field: targetHost/);
});

test("report payload rejects full URL as target host", () => {
  const payload = {
    ok: true,
    errorType: "none",
    modelClass: "sonnet",
    assistantStartBucket: "3_10s",
    timeBucket: 30000000,
    pluginVersion: "0.1.0",
    anonymousId: "anon_abcdefghijklmnop",
    sampleRate: 1,
    targetMatched: true,
    targetHost: "https://anyrouter.top"
  };

  const validation = validateReportPayload(payload);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /invalid targetHost/);
});

test("classifies Claude StopFailure error fields", () => {
  assert.equal(classifyError({ error: "api_error" }), "server_error");
  assert.equal(classifyError({ error: "rate_limit_error" }), "rate_limited");
  assert.equal(classifyError({ error_details: { status_code: 503 } }), "server_error");
  assert.equal(classifyError({ error_details: { message: "connection reset by peer" } }), "network_error");
  assert.equal(classifyError({ error_details: { message: "request timed out" } }), "timeout");
});

test("extracts and sanitizes StopFailure error details", () => {
  const input = {
    error_details: {
      status_code: 429,
      message: "API Error 429: quota exceeded for token sk_abcdefghijklmnopqrstuvwxyz123456"
    },
    last_assistant_message: "API Error: Rate limit reached"
  };

  assert.equal(extractErrorStatusCode(input), 429);
  assert.equal(createErrorHint(input), "API Error 429: quota exceeded for token [secret]");
  assert.equal(sanitizeErrorHint("failed at C:\\Users\\Lenovo\\secret\\file.txt with token=abc123"), "failed at [path] with token=[secret]");
});

test("report payload accepts optional sanitized error details", () => {
  const payload = {
    ok: false,
    errorType: "rate_limited",
    errorStatusCode: 429,
    errorHint: "API Error 429: Rate limit reached",
    modelClass: "sonnet",
    assistantStartBucket: "3_10s",
    timeBucket: 30000000,
    pluginVersion: PLUGIN_VERSION,
    anonymousId: "anon_abcdefghijklmnop",
    sampleRate: 1,
    targetMatched: true,
    targetHost: "anyrouter.top"
  };

  assert.equal(validateReportPayload(payload).ok, true);
  assert.equal(validateReportPayload({ ...payload, targetHost: "api.anthropic.com" }).ok, false);
});
