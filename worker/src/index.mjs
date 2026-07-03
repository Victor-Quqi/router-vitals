import { DEFAULT_REMOTE_CONFIG, SERVER_DAILY_REPORT_SAMPLE_RATE, normalizeClient, normalizeTargetHost, validateReportPayload } from "../../shared/policy.mjs";
import { createPlatformResponseBodyCache } from "./runtime-cache.mjs";
import { createSqlReportStore } from "./storage.mjs";
import { buildStatusFromRows, getStatusWindowSpec, parseStatusWindow } from "./status.mjs";
const JSON_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
};
export default {
    async fetch(request, env) {
        return handleRequest(request, env);
    },
    async scheduled(_event, env, ctx) {
        if (!env?.DB)
            return;
        const store = createSqlReportStore(env.DB);
        const options = env.ERROR_DETAIL_RETENTION_DAYS === undefined
            ? {}
            : { errorDetailRetentionDays: env.ERROR_DETAIL_RETENTION_DAYS };
        ctx.waitUntil(store.purgeExpiredData(Date.now(), options));
    }
};
export function createRuntimeServices() {
    return {
        statusCache: createPlatformResponseBodyCache()
    };
}
export async function handleRequest(request, env, runtime = createRuntimeServices()) {
    if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: JSON_HEADERS });
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/v1/config" || url.pathname === "/config.json")) {
        return json({ ...DEFAULT_REMOTE_CONFIG, apiBaseUrl: url.origin });
    }
    if (request.method === "GET" && url.pathname === "/v1/status")
        return handleStatus(url, env, runtime);
    if (request.method === "POST" && url.pathname === "/v1/report")
        return handleReport(request, env, runtime);
    if (request.method === "GET" && env?.ASSETS)
        return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, 404);
}
export async function handleReport(request, env, runtime = createRuntimeServices()) {
    const store = getReportStore(env, runtime);
    if (!store)
        return json({ error: "db_not_configured" }, 503);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 2048)
        return json({ error: "payload_too_large" }, 413);
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
    const targetHost = normalizeTargetHost(payload.targetHost);
    if (!targetHost)
        return json({ error: "invalid_payload", details: ["invalid targetHost"] }, 400);
    const nowMs = Date.now();
    const dailyDecision = await store.reserveDailyReportSlot(payload.anonymousId, nowMs);
    const random = runtime.random ?? Math.random;
    if (dailyDecision === "drop" || (dailyDecision === "sample" && random() >= SERVER_DAILY_REPORT_SAMPLE_RATE)) {
        return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    await store.recordReport({
        payload,
        nowMs,
        minute: Math.floor(nowMs / 60000),
        targetHost
    });
    return json({ ok: true });
}
export async function handleStatus(url, env, runtime = createRuntimeServices()) {
    const store = getReportStore(env, runtime);
    if (!store)
        return json({ error: "db_not_configured" }, 503);
    const windowValue = url.searchParams.get("window") || "60m";
    const minutes = parseStatusWindow(windowValue);
    const spec = getStatusWindowSpec(windowValue);
    if (!minutes)
        return json({ error: "invalid_window" }, 400);
    if (!spec)
        return json({ error: "invalid_window" }, 400);
    const targetHostResult = parseStatusTargetHost(url.searchParams.get("targetHost"));
    if (targetHostResult === undefined)
        return json({ error: "invalid_target_host" }, 400);
    const targetHost = targetHostResult;
    const clientResult = parseStatusClient(url.searchParams.get("client"));
    if (clientResult === undefined)
        return json({ error: "invalid_client" }, 400);
    const client = clientResult;
    const nowMs = Date.now();
    const cacheTtlMs = getStatusCacheTtlMs(windowValue);
    const cacheKey = `status:${windowValue}:${targetHost || "all"}:${client || "all"}`;
    const bypassCache = url.searchParams.get("refresh") === "1";
    const statusCache = runtime.statusCache === undefined ? createPlatformResponseBodyCache() : runtime.statusCache;
    const cached = bypassCache ? null : await statusCache?.get(cacheKey);
    if (cached)
        return jsonText(cached, 200, statusCacheHeaders(cacheTtlMs));
    const nowMinute = Math.floor(nowMs / 60000);
    const sinceMinute = nowMinute - minutes + 1;
    const [result, modelResult, modelErrorDetailResult] = await Promise.all([
        store.queryAggregates(sinceMinute, targetHost, client),
        store.queryModelAggregates(sinceMinute, targetHost, client),
        store.queryModelErrorDetails(sinceMinute, nowMinute, spec.bucketMinutes, targetHost, client)
    ]);
    const body = JSON.stringify(buildStatusFromRows(result.results || [], windowValue, modelResult.results || [], nowMinute, modelErrorDetailResult.results || []));
    await statusCache?.put(cacheKey, body, cacheTtlMs);
    return jsonText(body, 200, bypassCache ? { "cache-control": "no-store" } : statusCacheHeaders(cacheTtlMs));
}
function getReportStore(env, runtime) {
    if (runtime.reportStore)
        return runtime.reportStore;
    return env?.DB ? createSqlReportStore(env.DB) : null;
}
function parseStatusTargetHost(value) {
    if (!value || value === "all")
        return null;
    return normalizeTargetHost(value) ?? undefined;
}
function parseStatusClient(value) {
    if (!value || value === "all")
        return null;
    return normalizeClient(value) ?? undefined;
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
