import test from "node:test";
import assert from "node:assert/strict";
import {
  bucketLatency,
  classifyError,
  matchTargetBaseUrl,
  sanitizeRemoteConfig,
  validateReportPayload
} from "../shared/policy.mjs";

test("matches only AnyRouter target hosts", () => {
  assert.equal(matchTargetBaseUrl("https://anyrouter.top/v1/messages").matched, true);
  assert.equal(matchTargetBaseUrl("https://a-ocnfniawgw.cn-shanghai.fcapp.run").matched, true);
  assert.equal(matchTargetBaseUrl("https://api.anthropic.com").matched, false);
  assert.equal(matchTargetBaseUrl("https://example.com").matched, false);
});

test("remote target hosts are constrained to baked AnyRouter hosts", () => {
  const config = sanitizeRemoteConfig({
    targetBaseUrlHosts: ["anyrouter.top", "evil.example"],
    sampleRateSuccess: 2,
    sampleRateFailure: -1
  });

  assert.deepEqual(config.targetBaseUrlHosts, ["anyrouter.top"]);
  assert.equal(config.sampleRateSuccess, 1);
  assert.equal(config.sampleRateFailure, 0);
});

test("latency buckets are stable", () => {
  assert.equal(bucketLatency(100), "lt_3s");
  assert.equal(bucketLatency(3000), "3_10s");
  assert.equal(bucketLatency(10000), "10_30s");
  assert.equal(bucketLatency(30000), "30_60s");
  assert.equal(bucketLatency(60000), "gt_60s");
});

test("report payload rejects actual URLs and station fields", () => {
  const payload = {
    ok: true,
    errorType: "none",
    modelClass: "sonnet",
    latencyBucket: "3_10s",
    timeBucket: 30000000,
    pluginVersion: "0.1.0",
    anonymousId: "anon_abcdefghijklmnop",
    sampleRate: 1,
    targetMatched: true,
    baseUrl: "https://anyrouter.top",
    stationId: "anyrouter"
  };

  const validation = validateReportPayload(payload);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unknown field: baseUrl/);
  assert.match(validation.errors.join("\n"), /unknown field: stationId/);
});

test("classifies Claude StopFailure error fields", () => {
  assert.equal(classifyError({ error: "api_error" }), "server_error");
  assert.equal(classifyError({ error: "rate_limit_error" }), "rate_limited");
  assert.equal(classifyError({ error_details: { status_code: 503 } }), "server_error");
  assert.equal(classifyError({ error_details: { message: "connection reset by peer" } }), "network_error");
  assert.equal(classifyError({ error_details: { message: "request timed out" } }), "timeout");
});
