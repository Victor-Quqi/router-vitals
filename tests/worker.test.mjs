import test from "node:test";
import assert from "node:assert/strict";
import { handleReport, handleRequest } from "../worker/src/index.mjs";
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
  assert.equal(status.confidence, "insufficient");
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

function failingDb() {
  return {
    prepare() {
      throw new Error("D1 should not be used for invalid payloads");
    }
  };
}
