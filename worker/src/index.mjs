import {
  DEFAULT_REMOTE_CONFIG,
  ERROR_TYPES,
  LATENCY_BUCKETS,
  validateReportPayload
} from "../../shared/policy.mjs";
import { buildStatusFromRows, parseStatusWindow } from "./status.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

const LATENCY_COLUMNS = Object.freeze({
  lt_3s: "latency_lt_3s",
  "3_10s": "latency_3_10s",
  "10_30s": "latency_10_30s",
  "30_60s": "latency_30_60s",
  gt_60s: "latency_gt_60s",
  unknown: "latency_unknown"
});

const ERROR_COLUMNS = Object.freeze({
  none: "err_none",
  server_error: "err_server_error",
  rate_limited: "err_rate_limited",
  network_error: "err_network_error",
  auth_error: "err_auth_error",
  timeout: "err_timeout",
  unknown: "err_unknown"
});

const isolateRateLimit = new Map();

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeOldSamples(env));
  }
};

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/v1/config" || url.pathname === "/config.json")) {
    return json({ ...DEFAULT_REMOTE_CONFIG, apiBaseUrl: url.origin });
  }
  if (request.method === "GET" && url.pathname === "/v1/status") return handleStatus(url, env);
  if (request.method === "POST" && url.pathname === "/v1/report") return handleReport(request, env);

  return json({ error: "not_found" }, 404);
}

export async function handleReport(request, env) {
  if (!env?.DB) return json({ error: "db_not_configured" }, 503);

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 2048) return json({ error: "payload_too_large" }, 413);

  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  if (!allowRate(`ip:${ip}`, 90, 60000)) return json({ error: "rate_limited" }, 429);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const validation = validateReportPayload(payload);
  if (!validation.ok) return json({ error: "invalid_payload", details: validation.errors }, 400);
  if (!allowRate(`anon:${payload.anonymousId}`, 30, 60000)) return json({ error: "rate_limited" }, 429);

  const nowMs = Date.now();
  const minute = Math.floor(nowMs / 60000);
  await insertRawSample(env.DB, payload, nowMs, minute);
  await incrementAggregate(env.DB, payload, nowMs, minute);

  return json({ ok: true });
}

export async function handleStatus(url, env) {
  if (!env?.DB) return json({ error: "db_not_configured" }, 503);

  const windowValue = url.searchParams.get("window") || "15m";
  const minutes = parseStatusWindow(windowValue);
  if (!minutes) return json({ error: "invalid_window" }, 400);

  const nowMinute = Math.floor(Date.now() / 60000);
  const sinceMinute = nowMinute - minutes + 1;
  const result = await env.DB
    .prepare("SELECT * FROM minute_aggregates WHERE minute >= ? ORDER BY minute ASC")
    .bind(sinceMinute)
    .all();

  return json(buildStatusFromRows(result.results || [], windowValue));
}

async function insertRawSample(db, payload, nowMs, minute) {
  await db.prepare(`
    INSERT INTO samples_raw (
      id, created_at, minute, ok, error_type, model_class, latency_bucket, time_bucket,
      plugin_version, anonymous_id, sample_rate, target_matched
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    nowMs,
    minute,
    payload.ok ? 1 : 0,
    payload.errorType,
    payload.modelClass,
    payload.latencyBucket,
    payload.timeBucket,
    payload.pluginVersion,
    payload.anonymousId,
    payload.sampleRate,
    payload.targetMatched ? 1 : 0
  ).run();
}

async function incrementAggregate(db, payload, nowMs, minute) {
  const latencyColumn = LATENCY_COLUMNS[payload.latencyBucket] || LATENCY_COLUMNS.unknown;
  const errorColumn = ERROR_COLUMNS[payload.errorType] || ERROR_COLUMNS.unknown;
  const successDelta = payload.ok ? 1 : 0;
  const failureDelta = payload.ok ? 0 : 1;

  await db.prepare(`
    INSERT INTO minute_aggregates (
      minute, total_samples, success_samples, failure_samples, ${latencyColumn}, ${errorColumn}, updated_at
    ) VALUES (?, 1, ?, ?, 1, 1, ?)
    ON CONFLICT(minute) DO UPDATE SET
      total_samples = total_samples + 1,
      success_samples = success_samples + ?,
      failure_samples = failure_samples + ?,
      ${latencyColumn} = ${latencyColumn} + 1,
      ${errorColumn} = ${errorColumn} + 1,
      updated_at = ?
  `).bind(minute, successDelta, failureDelta, nowMs, successDelta, failureDelta, nowMs).run();
}

async function purgeOldSamples(env) {
  if (!env?.DB) return;
  const retentionHours = Number(env.RAW_SAMPLE_RETENTION_HOURS || 24);
  const cutoff = Date.now() - Math.max(1, retentionHours) * 60 * 60 * 1000;
  await env.DB.prepare("DELETE FROM samples_raw WHERE created_at < ?").bind(cutoff).run();
}

function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const item = isolateRateLimit.get(key);
  if (!item || item.resetAt <= now) {
    isolateRateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  item.count += 1;
  return item.count <= limit;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export function getAllowedWorkerValues() {
  return {
    errors: ERROR_TYPES,
    latencies: LATENCY_BUCKETS
  };
}
