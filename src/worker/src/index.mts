import {
  DEFAULT_REMOTE_CONFIG,
  ERROR_TYPES,
  LATENCY_BUCKETS,
  normalizeTargetHost,
  validateReportPayload,
  type ErrorType,
  type LatencyBucket,
  type ReportPayload,
  type TargetHost
} from "../../shared/policy.mjs";
import {
  buildStatusFromRows,
  getStatusWindowSpec,
  parseStatusWindow,
  type AggregateRow,
  type ModelErrorDetailRow,
  type ModelAggregateRow
} from "./status.mjs";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface WorkerEnv {
  DB?: D1Database;
  ASSETS?: AssetFetcher;
  RAW_SAMPLE_RETENTION_HOURS?: string | number;
  ERROR_DETAIL_RETENTION_DAYS?: string | number;
}

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

const LATENCY_COLUMNS: Record<LatencyBucket, string> = Object.freeze({
  lt_3s: "latency_lt_3s",
  "3_10s": "latency_3_10s",
  "10_30s": "latency_10_30s",
  "30_60s": "latency_30_60s",
  gt_60s: "latency_gt_60s",
  unknown: "latency_unknown"
});

const ERROR_COLUMNS: Record<ErrorType, string> = Object.freeze({
  none: "err_none",
  server_error: "err_server_error",
  rate_limited: "err_rate_limited",
  network_error: "err_network_error",
  auth_error: "err_auth_error",
  timeout: "err_timeout",
  unknown: "err_unknown"
});

const isolateRateLimit = new Map<string, { count: number; resetAt: number }>();
const statusResponseCache = new Map<string, { body: string; expiresAt: number }>();
const MAX_RETENTION_DAYS = 90;
const MAX_RETENTION_HOURS = MAX_RETENTION_DAYS * 24;
type StatusTargetHost = TargetHost | null;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ScheduledContext): Promise<void> {
    ctx.waitUntil(purgeExpiredData(env));
  }
};

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/v1/config" || url.pathname === "/config.json")) {
    return json({ ...DEFAULT_REMOTE_CONFIG, apiBaseUrl: url.origin });
  }
  if (request.method === "GET" && url.pathname === "/v1/status") return handleStatus(url, env);
  if (request.method === "POST" && url.pathname === "/v1/report") return handleReport(request, env);
  if (request.method === "GET" && env?.ASSETS) return env.ASSETS.fetch(request);

  return json({ error: "not_found" }, 404);
}

export async function handleReport(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env?.DB) return json({ error: "db_not_configured" }, 503);

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 2048) return json({ error: "payload_too_large" }, 413);

  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  if (!allowRate(`ip:${ip}`, 90, 60000)) return json({ error: "rate_limited" }, 429);

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const validation = validateReportPayload(rawPayload);
  if (!validation.ok) return json({ error: "invalid_payload", details: validation.errors }, 400);
  const payload = rawPayload as ReportPayload;
  if (!allowRate(`anon:${payload.anonymousId}`, 30, 60000)) return json({ error: "rate_limited" }, 429);
  const targetHost = normalizeTargetHost(payload.targetHost);
  if (!targetHost) return json({ error: "invalid_payload", details: ["invalid targetHost"] }, 400);

  const nowMs = Date.now();
  const minute = Math.floor(nowMs / 60000);
  await insertRawSample(env.DB, payload, nowMs, minute, targetHost);
  await incrementTargetAggregate(env.DB, payload, nowMs, minute, targetHost);
  await incrementTargetModelAggregate(env.DB, payload, nowMs, minute, targetHost);
  await incrementTargetErrorObservation(env.DB, payload, nowMs, minute, targetHost);
  await incrementTargetModelErrorObservation(env.DB, payload, nowMs, minute, targetHost);

  return json({ ok: true });
}

export async function handleStatus(url: URL, env: WorkerEnv): Promise<Response> {
  if (!env?.DB) return json({ error: "db_not_configured" }, 503);

  const windowValue = url.searchParams.get("window") || "60m";
  const minutes = parseStatusWindow(windowValue);
  const spec = getStatusWindowSpec(windowValue);
  if (!minutes) return json({ error: "invalid_window" }, 400);
  if (!spec) return json({ error: "invalid_window" }, 400);
  const targetHostResult = parseStatusTargetHost(url.searchParams.get("targetHost"));
  if (targetHostResult === undefined) return json({ error: "invalid_target_host" }, 400);
  const targetHost = targetHostResult;

  const nowMs = Date.now();
  const cacheTtlMs = getStatusCacheTtlMs(windowValue);
  const cacheKey = `status:${windowValue}:${targetHost || "all"}`;
  const bypassCache = url.searchParams.get("refresh") === "1";
  const cached = bypassCache ? undefined : statusResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return jsonText(cached.body, 200, statusCacheHeaders(cacheTtlMs));
  }

  const nowMinute = Math.floor(nowMs / 60000);
  const sinceMinute = nowMinute - minutes + 1;
  const [result, modelResult, modelErrorDetailResult] = await Promise.all([
    queryAggregates(env.DB, sinceMinute, targetHost),
    queryModelAggregates(env.DB, sinceMinute, targetHost),
    queryModelErrorDetails(env.DB, sinceMinute, nowMinute, spec.bucketMinutes, targetHost)
  ]);

  const body = JSON.stringify(buildStatusFromRows(
    result.results || [],
    windowValue,
    modelResult.results || [],
    nowMinute,
    modelErrorDetailResult.results || []
  ));
  statusResponseCache.set(cacheKey, { body, expiresAt: nowMs + cacheTtlMs });

  return jsonText(body, 200, bypassCache ? { "cache-control": "no-store" } : statusCacheHeaders(cacheTtlMs));
}

async function insertRawSample(db: D1Database, payload: ReportPayload, nowMs: number, minute: number, targetHost: TargetHost): Promise<void> {
  await db.prepare(`
    INSERT INTO samples_raw (
      id, created_at, minute, ok, error_type, model_class, latency_bucket, time_bucket,
      plugin_version, anonymous_id, sample_rate, target_matched, error_status_code, error_hint, target_host
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    payload.targetMatched ? 1 : 0,
    payload.errorStatusCode ?? null,
    payload.errorHint ?? null,
    targetHost
  ).run();
}

async function incrementTargetAggregate(db: D1Database, payload: ReportPayload, nowMs: number, minute: number, targetHost: TargetHost): Promise<void> {
  const latencyColumn = LATENCY_COLUMNS[payload.latencyBucket] || LATENCY_COLUMNS.unknown;
  const errorColumn = ERROR_COLUMNS[payload.errorType] || ERROR_COLUMNS.unknown;
  const successDelta = payload.ok ? 1 : 0;
  const failureDelta = payload.ok ? 0 : 1;

  await db.prepare(`
    INSERT INTO target_minute_aggregates (
      target_host, minute, total_samples, success_samples, failure_samples, ${latencyColumn}, ${errorColumn}, updated_at
    ) VALUES (?, ?, 1, ?, ?, 1, 1, ?)
    ON CONFLICT(target_host, minute) DO UPDATE SET
      total_samples = total_samples + 1,
      success_samples = success_samples + ?,
      failure_samples = failure_samples + ?,
      ${latencyColumn} = ${latencyColumn} + 1,
      ${errorColumn} = ${errorColumn} + 1,
      updated_at = ?
  `).bind(targetHost, minute, successDelta, failureDelta, nowMs, successDelta, failureDelta, nowMs).run();
}

async function incrementTargetModelAggregate(db: D1Database, payload: ReportPayload, nowMs: number, minute: number, targetHost: TargetHost): Promise<void> {
  const successDelta = payload.ok ? 1 : 0;
  const failureDelta = payload.ok ? 0 : 1;

  await db.prepare(`
    INSERT INTO target_model_minute_aggregates (
      target_host, minute, model_class, total_samples, success_samples, failure_samples, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(target_host, minute, model_class) DO UPDATE SET
      total_samples = total_samples + 1,
      success_samples = success_samples + ?,
      failure_samples = failure_samples + ?,
      updated_at = ?
  `).bind(
    targetHost,
    minute,
    payload.modelClass,
    successDelta,
    failureDelta,
    nowMs,
    successDelta,
    failureDelta,
    nowMs
  ).run();
}

async function incrementTargetErrorObservation(db: D1Database, payload: ReportPayload, nowMs: number, minute: number, targetHost: TargetHost): Promise<void> {
  if (payload.ok) return;

  const statusCode = payload.errorStatusCode ?? null;
  const errorHint = payload.errorHint || null;
  const statusKey = statusCode === null ? "none" : String(statusCode);
  const hintKey = errorHint || "none";

  await db.prepare(`
    INSERT INTO target_error_observations (
      target_host, minute, error_type, status_key, status_code, hint_key, error_hint, count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(target_host, minute, error_type, status_key, hint_key) DO UPDATE SET
      count = count + 1,
      updated_at = ?
  `).bind(
    targetHost,
    minute,
    payload.errorType,
    statusKey,
    statusCode,
    hintKey,
    errorHint,
    nowMs,
    nowMs
  ).run();
}

async function incrementTargetModelErrorObservation(db: D1Database, payload: ReportPayload, nowMs: number, minute: number, targetHost: TargetHost): Promise<void> {
  if (payload.ok) return;

  const statusCode = payload.errorStatusCode ?? null;
  const errorHint = payload.errorHint || null;
  const statusKey = statusCode === null ? "none" : String(statusCode);
  const hintKey = errorHint || "none";

  await db.prepare(`
    INSERT INTO target_model_error_observations (
      target_host, minute, model_class, error_type, status_key, status_code, hint_key, error_hint, count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(target_host, minute, model_class, error_type, status_key, hint_key) DO UPDATE SET
      count = count + 1,
      updated_at = ?
  `).bind(
    targetHost,
    minute,
    payload.modelClass,
    payload.errorType,
    statusKey,
    statusCode,
    hintKey,
    errorHint,
    nowMs,
    nowMs
  ).run();
}

async function queryAggregates(db: D1Database, sinceMinute: number, targetHost: StatusTargetHost): Promise<{ results?: AggregateRow[] }> {
  if (!targetHost) {
    return db
      .prepare(`
        SELECT
          minute,
          SUM(total_samples) AS total_samples,
          SUM(success_samples) AS success_samples,
          SUM(failure_samples) AS failure_samples,
          SUM(latency_lt_3s) AS latency_lt_3s,
          SUM(latency_3_10s) AS latency_3_10s,
          SUM(latency_10_30s) AS latency_10_30s,
          SUM(latency_30_60s) AS latency_30_60s,
          SUM(latency_gt_60s) AS latency_gt_60s,
          SUM(latency_unknown) AS latency_unknown,
          SUM(err_none) AS err_none,
          SUM(err_server_error) AS err_server_error,
          SUM(err_rate_limited) AS err_rate_limited,
          SUM(err_network_error) AS err_network_error,
          SUM(err_auth_error) AS err_auth_error,
          SUM(err_timeout) AS err_timeout,
          SUM(err_unknown) AS err_unknown
        FROM target_minute_aggregates
        WHERE minute >= ?
        GROUP BY minute
        ORDER BY minute ASC
      `)
      .bind(sinceMinute)
      .all<AggregateRow>();
  }

  return db
    .prepare("SELECT * FROM target_minute_aggregates WHERE target_host = ? AND minute >= ? ORDER BY minute ASC")
    .bind(targetHost, sinceMinute)
    .all<AggregateRow>();
}

async function queryModelAggregates(db: D1Database, sinceMinute: number, targetHost: StatusTargetHost): Promise<{ results?: ModelAggregateRow[] }> {
  if (!targetHost) {
    return db
      .prepare(`
        SELECT
          minute,
          model_class,
          SUM(total_samples) AS total_samples,
          SUM(success_samples) AS success_samples,
          SUM(failure_samples) AS failure_samples
        FROM target_model_minute_aggregates
        WHERE minute >= ?
        GROUP BY minute, model_class
        ORDER BY minute ASC, model_class ASC
      `)
      .bind(sinceMinute)
      .all<ModelAggregateRow>();
  }

  return db
    .prepare(`
      SELECT minute, model_class, total_samples, success_samples, failure_samples
      FROM target_model_minute_aggregates
      WHERE target_host = ? AND minute >= ?
      ORDER BY minute ASC, model_class ASC
    `)
    .bind(targetHost, sinceMinute)
    .all<ModelAggregateRow>();
}

async function queryModelErrorDetails(
  db: D1Database,
  sinceMinute: number,
  nowMinute: number,
  bucketMinutes: number,
  targetHost: StatusTargetHost
): Promise<{ results?: ModelErrorDetailRow[] }> {
  if (!targetHost) {
    return db
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
          FROM target_model_error_observations
          WHERE minute >= ? AND minute <= ?
        )
        GROUP BY bucket_index, model_class, error_type, status_code, error_hint
        ORDER BY bucket_index ASC, model_class ASC, count DESC
      `)
      .bind(sinceMinute, bucketMinutes, sinceMinute, nowMinute)
      .all<ModelErrorDetailRow>();
  }

  return db
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
        FROM target_model_error_observations
        WHERE target_host = ? AND minute >= ? AND minute <= ?
      )
      GROUP BY bucket_index, model_class, error_type, status_code, error_hint
      ORDER BY bucket_index ASC, model_class ASC, count DESC
    `)
    .bind(sinceMinute, bucketMinutes, targetHost, sinceMinute, nowMinute)
    .all<ModelErrorDetailRow>();
}

async function purgeExpiredData(env: WorkerEnv): Promise<void> {
  if (!env?.DB) return;
  const nowMs = Date.now();
  const retentionHours = parseBoundedRetention(env.RAW_SAMPLE_RETENTION_HOURS, 24, 1, MAX_RETENTION_HOURS);
  const cutoff = nowMs - retentionHours * 60 * 60 * 1000;
  await env.DB.prepare("DELETE FROM samples_raw WHERE created_at < ?").bind(cutoff).run();

  const detailRetentionDays = parseBoundedRetention(env.ERROR_DETAIL_RETENTION_DAYS, 31, 1, MAX_RETENTION_DAYS);
  const cutoffMinute = Math.floor((nowMs - detailRetentionDays * 24 * 60 * 60 * 1000) / 60000);
  await env.DB.prepare("DELETE FROM target_error_observations WHERE minute < ?").bind(cutoffMinute).run();
  await env.DB.prepare("DELETE FROM target_model_error_observations WHERE minute < ?").bind(cutoffMinute).run();

  const aggregateCutoffMinute = Math.floor((nowMs - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 60000);
  await env.DB.prepare("DELETE FROM target_minute_aggregates WHERE minute < ?").bind(aggregateCutoffMinute).run();
  await env.DB.prepare("DELETE FROM target_model_minute_aggregates WHERE minute < ?").bind(aggregateCutoffMinute).run();
}

function parseBoundedRetention(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function allowRate(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const item = isolateRateLimit.get(key);
  if (!item || item.resetAt <= now) {
    isolateRateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  item.count += 1;
  return item.count <= limit;
}

function parseStatusTargetHost(value: string | null): StatusTargetHost | undefined {
  if (!value || value === "all") return null;
  return normalizeTargetHost(value) ?? undefined;
}

function getStatusCacheTtlMs(windowValue: string): number {
  if (windowValue === "24h") return 60_000;
  if (windowValue === "7d") return 5 * 60_000;
  if (windowValue === "30d") return 10 * 60_000;
  return 20_000;
}

function statusCacheHeaders(ttlMs: number): Record<string, string> {
  return { "cache-control": `public, max-age=${Math.max(0, Math.floor(ttlMs / 1000))}` };
}

function jsonText(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export function getAllowedWorkerValues(): { errors: typeof ERROR_TYPES; latencies: typeof LATENCY_BUCKETS } {
  return {
    errors: ERROR_TYPES,
    latencies: LATENCY_BUCKETS
  };
}
