import { DEFAULT_REMOTE_CONFIG, ERROR_TYPES, LATENCY_BUCKETS, validateReportPayload } from "../../shared/policy.mjs";
import { buildStatusFromRows, getStatusWindowSpec, parseStatusWindow } from "./status.mjs";
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
const statusResponseCache = new Map();
const MAX_RETENTION_DAYS = 90;
const MAX_RETENTION_HOURS = MAX_RETENTION_DAYS * 24;
export default {
    async fetch(request, env) {
        return handleRequest(request, env);
    },
    async scheduled(_event, env, ctx) {
        ctx.waitUntil(purgeExpiredData(env));
    }
};
export async function handleRequest(request, env) {
    if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: JSON_HEADERS });
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/v1/config" || url.pathname === "/config.json")) {
        return json({ ...DEFAULT_REMOTE_CONFIG, apiBaseUrl: url.origin });
    }
    if (request.method === "GET" && url.pathname === "/v1/status")
        return handleStatus(url, env);
    if (request.method === "POST" && url.pathname === "/v1/report")
        return handleReport(request, env);
    return json({ error: "not_found" }, 404);
}
export async function handleReport(request, env) {
    if (!env?.DB)
        return json({ error: "db_not_configured" }, 503);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 2048)
        return json({ error: "payload_too_large" }, 413);
    const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
    if (!allowRate(`ip:${ip}`, 90, 60000))
        return json({ error: "rate_limited" }, 429);
    let rawPayload;
    try {
        rawPayload = await request.json();
    }
    catch {
        return json({ error: "invalid_json" }, 400);
    }
    const validation = validateReportPayload(rawPayload);
    if (!validation.ok)
        return json({ error: "invalid_payload", details: validation.errors }, 400);
    const payload = rawPayload;
    if (!allowRate(`anon:${payload.anonymousId}`, 30, 60000))
        return json({ error: "rate_limited" }, 429);
    const nowMs = Date.now();
    const minute = Math.floor(nowMs / 60000);
    await insertRawSample(env.DB, payload, nowMs, minute);
    await incrementAggregate(env.DB, payload, nowMs, minute);
    await incrementModelAggregate(env.DB, payload, nowMs, minute);
    await incrementErrorObservation(env.DB, payload, nowMs, minute);
    await incrementModelErrorObservation(env.DB, payload, nowMs, minute);
    return json({ ok: true });
}
export async function handleStatus(url, env) {
    if (!env?.DB)
        return json({ error: "db_not_configured" }, 503);
    const windowValue = url.searchParams.get("window") || "60m";
    const minutes = parseStatusWindow(windowValue);
    const spec = getStatusWindowSpec(windowValue);
    if (!minutes)
        return json({ error: "invalid_window" }, 400);
    if (!spec)
        return json({ error: "invalid_window" }, 400);
    const nowMs = Date.now();
    const cacheTtlMs = getStatusCacheTtlMs(windowValue);
    const cacheKey = `status:${windowValue}`;
    const bypassCache = url.searchParams.get("refresh") === "1";
    const cached = bypassCache ? undefined : statusResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
        return jsonText(cached.body, 200, statusCacheHeaders(cacheTtlMs));
    }
    const nowMinute = Math.floor(nowMs / 60000);
    const sinceMinute = nowMinute - minutes + 1;
    const [result, modelResult, modelErrorDetailResult] = await Promise.all([
        env.DB
            .prepare("SELECT * FROM minute_aggregates WHERE minute >= ? ORDER BY minute ASC")
            .bind(sinceMinute)
            .all(),
        env.DB
            .prepare(`
        SELECT minute, model_class, total_samples, success_samples, failure_samples
        FROM model_minute_aggregates
        WHERE minute >= ?
        ORDER BY minute ASC, model_class ASC
      `)
            .bind(sinceMinute)
            .all(),
        env.DB
            .prepare(`
        SELECT bucket_index, model_class, error_type, status_code, error_hint, SUM(count) AS count
        FROM (
          SELECT
            CAST((minute - ?) / ? AS INTEGER) AS bucket_index,
            model_class,
            error_type,
            status_code,
            error_hint,
            count
          FROM model_error_observations
          WHERE minute >= ? AND minute <= ?
        )
        GROUP BY bucket_index, model_class, error_type, status_code, error_hint
        ORDER BY bucket_index ASC, model_class ASC, count DESC
      `)
            .bind(sinceMinute, spec.bucketMinutes, sinceMinute, nowMinute)
            .all()
    ]);
    const body = JSON.stringify(buildStatusFromRows(result.results || [], windowValue, modelResult.results || [], nowMinute, modelErrorDetailResult.results || []));
    statusResponseCache.set(cacheKey, { body, expiresAt: nowMs + cacheTtlMs });
    return jsonText(body, 200, bypassCache ? { "cache-control": "no-store" } : statusCacheHeaders(cacheTtlMs));
}
async function insertRawSample(db, payload, nowMs, minute) {
    await db.prepare(`
    INSERT INTO samples_raw (
      id, created_at, minute, ok, error_type, model_class, latency_bucket, time_bucket,
      plugin_version, anonymous_id, sample_rate, target_matched, error_status_code, error_hint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), nowMs, minute, payload.ok ? 1 : 0, payload.errorType, payload.modelClass, payload.latencyBucket, payload.timeBucket, payload.pluginVersion, payload.anonymousId, payload.sampleRate, payload.targetMatched ? 1 : 0, payload.errorStatusCode ?? null, payload.errorHint ?? null).run();
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
async function incrementModelAggregate(db, payload, nowMs, minute) {
    const successDelta = payload.ok ? 1 : 0;
    const failureDelta = payload.ok ? 0 : 1;
    await db.prepare(`
    INSERT INTO model_minute_aggregates (
      minute, model_class, total_samples, success_samples, failure_samples, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(minute, model_class) DO UPDATE SET
      total_samples = total_samples + 1,
      success_samples = success_samples + ?,
      failure_samples = failure_samples + ?,
      updated_at = ?
  `).bind(minute, payload.modelClass, successDelta, failureDelta, nowMs, successDelta, failureDelta, nowMs).run();
}
async function incrementErrorObservation(db, payload, nowMs, minute) {
    if (payload.ok)
        return;
    const statusCode = payload.errorStatusCode ?? null;
    const errorHint = payload.errorHint || null;
    const statusKey = statusCode === null ? "none" : String(statusCode);
    const hintKey = errorHint || "none";
    await db.prepare(`
    INSERT INTO error_observations (
      minute, error_type, status_key, status_code, hint_key, error_hint, count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(minute, error_type, status_key, hint_key) DO UPDATE SET
      count = count + 1,
      updated_at = ?
  `).bind(minute, payload.errorType, statusKey, statusCode, hintKey, errorHint, nowMs, nowMs).run();
}
async function incrementModelErrorObservation(db, payload, nowMs, minute) {
    if (payload.ok)
        return;
    const statusCode = payload.errorStatusCode ?? null;
    const errorHint = payload.errorHint || null;
    const statusKey = statusCode === null ? "none" : String(statusCode);
    const hintKey = errorHint || "none";
    await db.prepare(`
    INSERT INTO model_error_observations (
      minute, model_class, error_type, status_key, status_code, hint_key, error_hint, count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(minute, model_class, error_type, status_key, hint_key) DO UPDATE SET
      count = count + 1,
      updated_at = ?
  `).bind(minute, payload.modelClass, payload.errorType, statusKey, statusCode, hintKey, errorHint, nowMs, nowMs).run();
}
async function purgeExpiredData(env) {
    if (!env?.DB)
        return;
    const nowMs = Date.now();
    const retentionHours = parseBoundedRetention(env.RAW_SAMPLE_RETENTION_HOURS, 24, 1, MAX_RETENTION_HOURS);
    const cutoff = nowMs - retentionHours * 60 * 60 * 1000;
    await env.DB.prepare("DELETE FROM samples_raw WHERE created_at < ?").bind(cutoff).run();
    const detailRetentionDays = parseBoundedRetention(env.ERROR_DETAIL_RETENTION_DAYS, 31, 1, MAX_RETENTION_DAYS);
    const cutoffMinute = Math.floor((nowMs - detailRetentionDays * 24 * 60 * 60 * 1000) / 60000);
    await env.DB.prepare("DELETE FROM error_observations WHERE minute < ?").bind(cutoffMinute).run();
    await env.DB.prepare("DELETE FROM model_error_observations WHERE minute < ?").bind(cutoffMinute).run();
    const aggregateCutoffMinute = Math.floor((nowMs - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 60000);
    await env.DB.prepare("DELETE FROM minute_aggregates WHERE minute < ?").bind(aggregateCutoffMinute).run();
    await env.DB.prepare("DELETE FROM model_minute_aggregates WHERE minute < ?").bind(aggregateCutoffMinute).run();
}
function parseBoundedRetention(value, fallback, min, max) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
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
function getStatusCacheTtlMs(windowValue) {
    if (windowValue === "24h")
        return 60_000;
    if (windowValue === "7d")
        return 5 * 60_000;
    if (windowValue === "30d")
        return 10 * 60_000;
    return 20_000;
}
function statusCacheHeaders(ttlMs) {
    return { "cache-control": `public, max-age=${Math.max(0, Math.floor(ttlMs / 1000))}` };
}
function jsonText(body, status = 200, headers = {}) {
    return new Response(body, { status, headers: { ...JSON_HEADERS, ...headers } });
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
