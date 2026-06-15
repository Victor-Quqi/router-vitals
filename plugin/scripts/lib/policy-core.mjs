export const PLUGIN_VERSION = "0.1.4";

export const TARGET_HOSTS = Object.freeze([
  "anyrouter.top",
  "a-ocnfniawgw.cn-shanghai.fcapp.run"
]);

export const DEFAULT_API_BASE_URL = "https://router-vitals-api.v1756251285.workers.dev";
export const DEFAULT_CONFIG_URL = "https://router-vitals-api.v1756251285.workers.dev/config.json";

export const ERROR_TYPES = Object.freeze([
  "none",
  "server_error",
  "rate_limited",
  "network_error",
  "auth_error",
  "timeout",
  "unknown"
]);

export const MODEL_CLASSES = Object.freeze(["haiku", "sonnet", "opus", "unknown"]);

export const LATENCY_BUCKETS = Object.freeze([
  "lt_3s",
  "3_10s",
  "10_30s",
  "30_60s",
  "gt_60s",
  "unknown"
]);

export const REPORT_FIELDS = Object.freeze([
  "ok",
  "errorType",
  "modelClass",
  "latencyBucket",
  "timeBucket",
  "pluginVersion",
  "anonymousId",
  "sampleRate",
  "targetMatched"
]);

export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  reportingEnabled: true,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  targetBaseUrlHosts: TARGET_HOSTS,
  sampleRateSuccess: 1,
  sampleRateFailure: 1,
  minPluginVersion: "0.1.0",
  statusWindows: ["90m", "24h", "7d", "30d"]
});

const STATUS_WINDOWS = Object.freeze(["5m", "15m", "60m", "90m", "24h", "7d", "30d"]);

export function normalizeHostFromBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeTargetHosts(value) {
  if (!Array.isArray(value)) return [...TARGET_HOSTS];
  const allowed = new Set(TARGET_HOSTS);
  const hosts = value
    .filter((host) => typeof host === "string")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => allowed.has(host));
  return hosts.length > 0 ? [...new Set(hosts)] : [...TARGET_HOSTS];
}

export function matchTargetBaseUrl(baseUrl, targetHosts = TARGET_HOSTS) {
  const host = normalizeHostFromBaseUrl(baseUrl);
  if (!host) return { matched: false, host: null };
  const normalizedTargets = normalizeTargetHosts(targetHosts);
  return { matched: normalizedTargets.includes(host), host };
}

export function getTodayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function createTimeBucket(nowMs = Date.now()) {
  return Math.floor(nowMs / 60000);
}

export function bucketLatency(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  if (durationMs < 3000) return "lt_3s";
  if (durationMs < 10000) return "3_10s";
  if (durationMs < 30000) return "10_30s";
  if (durationMs < 60000) return "30_60s";
  return "gt_60s";
}

export function classifyModel(input) {
  const envModel = globalThis.process?.env?.CLAUDE_MODEL;
  const raw = [
    input?.model?.id,
    input?.model?.name,
    input?.model?.display_name,
    input?.model,
    envModel
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (raw.includes("haiku")) return "haiku";
  if (raw.includes("sonnet")) return "sonnet";
  if (raw.includes("opus")) return "opus";
  return "unknown";
}

export function classifyError(input) {
  const raw = collectErrorParts(input).join(" ").toLowerCase();

  if (raw.includes("rate") || raw.includes("rate_limit") || raw.includes("429") || raw.includes("quota")) return "rate_limited";
  if (raw.includes("auth") || raw.includes("unauthorized") || raw.includes("401") || raw.includes("403")) return "auth_error";
  if (raw.includes("timeout") || raw.includes("timed out") || raw.includes("etimedout")) return "timeout";
  if (raw.includes("network") || raw.includes("connection") || raw.includes("econn") || raw.includes("enotfound") || raw.includes("fetch failed")) return "network_error";
  if (raw.includes("api_error") || raw.includes("overloaded") || raw.includes("500") || raw.includes("502") || raw.includes("503") || raw.includes("504") || raw.includes("server")) return "server_error";
  return "unknown";
}

function collectErrorParts(input) {
  return [
    input?.error_type,
    input?.errorType,
    input?.reason,
    input?.message,
    input?.status,
    input?.status_code,
    input?.code,
    input?.error,
    input?.error_details,
    input?.error?.type,
    input?.error?.name,
    input?.error?.code,
    input?.error?.status,
    input?.error?.status_code,
    input?.error?.message,
    input?.error_details?.type,
    input?.error_details?.name,
    input?.error_details?.code,
    input?.error_details?.status,
    input?.error_details?.status_code,
    input?.error_details?.message
  ]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map((value) => String(value));
}

export function pickSampleRate(ok, config) {
  const key = ok ? "sampleRateSuccess" : "sampleRateFailure";
  const value = Number(config?.[key]);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export function shouldSample(sampleRate, random = Math.random) {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return random() < sampleRate;
}

export function validateReportPayload(payload) {
  const errors = [];
  const fieldSet = new Set(REPORT_FIELDS);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be an object"] };
  }

  for (const key of Object.keys(payload)) {
    if (!fieldSet.has(key)) errors.push(`unknown field: ${key}`);
  }

  for (const key of REPORT_FIELDS) {
    if (!(key in payload)) errors.push(`missing field: ${key}`);
  }

  if (typeof payload.ok !== "boolean") errors.push("ok must be boolean");
  if (!ERROR_TYPES.includes(payload.errorType)) errors.push("invalid errorType");
  if (payload.ok === true && payload.errorType !== "none") errors.push("successful reports must use errorType=none");
  if (payload.ok === false && payload.errorType === "none") errors.push("failed reports must include an error type");
  if (!MODEL_CLASSES.includes(payload.modelClass)) errors.push("invalid modelClass");
  if (!LATENCY_BUCKETS.includes(payload.latencyBucket)) errors.push("invalid latencyBucket");
  if (!Number.isInteger(payload.timeBucket) || payload.timeBucket < 25000000) errors.push("invalid timeBucket");
  if (typeof payload.pluginVersion !== "string" || !/^\d+\.\d+\.\d+/.test(payload.pluginVersion)) errors.push("invalid pluginVersion");
  if (typeof payload.anonymousId !== "string" || !/^anon_[A-Za-z0-9_-]{16,80}$/.test(payload.anonymousId)) errors.push("invalid anonymousId");
  if (typeof payload.sampleRate !== "number" || !Number.isFinite(payload.sampleRate) || payload.sampleRate <= 0 || payload.sampleRate > 1) errors.push("invalid sampleRate");
  if (payload.targetMatched !== true) errors.push("targetMatched must be true");

  return { ok: errors.length === 0, errors };
}

export function sanitizeRemoteConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_REMOTE_CONFIG };
  return {
    reportingEnabled: value.reportingEnabled !== false,
    apiBaseUrl: typeof value.apiBaseUrl === "string" && value.apiBaseUrl.startsWith("http") ? value.apiBaseUrl : DEFAULT_API_BASE_URL,
    targetBaseUrlHosts: normalizeTargetHosts(value.targetBaseUrlHosts),
    sampleRateSuccess: clampRate(value.sampleRateSuccess, DEFAULT_REMOTE_CONFIG.sampleRateSuccess),
    sampleRateFailure: clampRate(value.sampleRateFailure, DEFAULT_REMOTE_CONFIG.sampleRateFailure),
    minPluginVersion: typeof value.minPluginVersion === "string" ? value.minPluginVersion : DEFAULT_REMOTE_CONFIG.minPluginVersion,
    statusWindows: Array.isArray(value.statusWindows) ? value.statusWindows.filter((item) => STATUS_WINDOWS.includes(item)) : DEFAULT_REMOTE_CONFIG.statusWindows
  };
}

function clampRate(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}
