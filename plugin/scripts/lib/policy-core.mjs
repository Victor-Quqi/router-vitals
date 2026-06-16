export const PLUGIN_VERSION = "0.1.9";
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
    "errorStatusCode",
    "errorHint",
    "modelClass",
    "latencyBucket",
    "timeBucket",
    "pluginVersion",
    "anonymousId",
    "sampleRate",
    "targetMatched",
    "targetHost"
]);
const REQUIRED_REPORT_FIELDS = Object.freeze([
    "ok",
    "errorType",
    "modelClass",
    "latencyBucket",
    "timeBucket",
    "pluginVersion",
    "anonymousId",
    "sampleRate",
    "targetMatched",
    "targetHost"
]);
const STATUS_WINDOWS = Object.freeze(["5m", "15m", "60m", "90m", "24h", "7d", "30d"]);
export const DEFAULT_REMOTE_CONFIG = Object.freeze({
    reportingEnabled: true,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    targetBaseUrlHosts: TARGET_HOSTS,
    sampleRateSuccess: 1,
    sampleRateFailure: 1,
    minPluginVersion: PLUGIN_VERSION,
    statusWindows: ["60m", "24h", "7d", "30d"]
});
export function normalizeHostFromBaseUrl(value) {
    if (typeof value !== "string" || value.trim() === "")
        return null;
    try {
        return new URL(value.trim()).hostname.toLowerCase();
    }
    catch {
        return null;
    }
}
export function normalizeTargetHosts(value) {
    if (!Array.isArray(value))
        return [...TARGET_HOSTS];
    const hosts = value
        .map(normalizeTargetHost)
        .filter((host) => host !== null);
    return hosts.length > 0 ? [...new Set(hosts)] : [...TARGET_HOSTS];
}
export function normalizeTargetHost(value) {
    if (typeof value !== "string")
        return null;
    const host = value.trim().toLowerCase();
    return TARGET_HOSTS.includes(host) ? host : null;
}
export function matchTargetBaseUrl(baseUrl, targetHosts = TARGET_HOSTS) {
    const host = normalizeHostFromBaseUrl(baseUrl);
    if (!host)
        return { matched: false, host: null };
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
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)
        return "unknown";
    if (durationMs < 3000)
        return "lt_3s";
    if (durationMs < 10000)
        return "3_10s";
    if (durationMs < 30000)
        return "10_30s";
    if (durationMs < 60000)
        return "30_60s";
    return "gt_60s";
}
export function classifyModel(input, { includeEnv = true } = {}) {
    const inputRaw = [
        input?.model?.id,
        input?.model?.name,
        input?.model?.display_name,
        input?.model?.displayName,
        input?.model_id,
        input?.model_name,
        input?.model,
    ]
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();
    const inputModelClass = classifyModelText(inputRaw);
    if (inputModelClass !== "unknown" || !includeEnv)
        return inputModelClass;
    return classifyModelText([
        globalThis.process?.env?.ANTHROPIC_MODEL,
        globalThis.process?.env?.CLAUDE_MODEL
    ]
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase());
}
function classifyModelText(raw) {
    if (raw.includes("haiku"))
        return "haiku";
    if (raw.includes("sonnet"))
        return "sonnet";
    if (raw.includes("opus"))
        return "opus";
    return "unknown";
}
export function classifyError(input) {
    const raw = collectErrorParts(input).join(" ").toLowerCase();
    if (raw.includes("rate") || raw.includes("rate_limit") || raw.includes("429") || raw.includes("quota"))
        return "rate_limited";
    if (raw.includes("auth") || raw.includes("unauthorized") || raw.includes("401") || raw.includes("403"))
        return "auth_error";
    if (raw.includes("timeout") || raw.includes("timed out") || raw.includes("etimedout"))
        return "timeout";
    if (raw.includes("network") || raw.includes("connection") || raw.includes("econn") || raw.includes("enotfound") || raw.includes("fetch failed"))
        return "network_error";
    if (raw.includes("api_error") || raw.includes("overloaded") || raw.includes("500") || raw.includes("502") || raw.includes("503") || raw.includes("504") || raw.includes("server"))
        return "server_error";
    return "unknown";
}
export function extractErrorStatusCode(input) {
    const directValues = [
        input?.status,
        input?.status_code,
        input?.code,
        input?.error?.status,
        input?.error?.status_code,
        input?.error?.code,
        input?.error_details?.status,
        input?.error_details?.status_code,
        input?.error_details?.code
    ];
    for (const value of directValues) {
        const statusCode = parseHttpStatusCode(value);
        if (statusCode !== null)
            return statusCode;
    }
    const raw = [
        ...collectErrorParts(input),
        input?.last_assistant_message
    ]
        .filter((value) => typeof value === "string" || typeof value === "number")
        .join(" ");
    const match = raw.match(/\b([45]\d{2})\b/);
    return match ? Number(match[1] ?? 0) : null;
}
export function createErrorHint(input) {
    const candidates = [
        input?.error_details?.message,
        input?.error?.message,
        input?.message,
        input?.last_assistant_message,
        typeof input?.error_details === "string" ? input.error_details : null,
        typeof input?.error === "string" ? input.error : null
    ];
    for (const candidate of candidates) {
        const sanitized = sanitizeErrorHint(candidate);
        if (sanitized)
            return sanitized;
    }
    return null;
}
export function sanitizeErrorHint(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return null;
    let text = String(value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text)
        return null;
    text = text
        .replace(/https?:\/\/[^\s)]+/gi, "[url]")
        .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
        .replace(/(^|\s)\/(?:Users|home|var|tmp|mnt|workspace|root)(?:\/[^\s]+)+/g, "$1[path]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[secret]")
        .replace(/\b(authorization|cookie|x-api-key|api[_-]?key|token|secret)\s*[:=]\s*[^,\s;]+/gi, "$1=[secret]")
        .replace(/\b(?:sk|ak|pk)_[A-Za-z0-9_-]{16,}\b/gi, "[secret]")
        .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[id]");
    text = text.replace(/\s+/g, " ").trim();
    if (!text)
        return null;
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
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
function parseHttpStatusCode(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599)
        return value;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!/^[45]\d{2}$/.test(trimmed))
        return null;
    return Number(trimmed);
}
export function pickSampleRate(ok, config) {
    const key = ok ? "sampleRateSuccess" : "sampleRateFailure";
    const value = Number(config?.[key]);
    if (!Number.isFinite(value))
        return 1;
    return Math.max(0, Math.min(1, value));
}
export function shouldSample(sampleRate, random = Math.random) {
    if (sampleRate >= 1)
        return true;
    if (sampleRate <= 0)
        return false;
    return random() < sampleRate;
}
export function validateReportPayload(payload) {
    const errors = [];
    const fieldSet = new Set(REPORT_FIELDS);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, errors: ["payload must be an object"] };
    }
    const report = payload;
    for (const key of Object.keys(report)) {
        if (!fieldSet.has(key))
            errors.push(`unknown field: ${key}`);
    }
    for (const key of REQUIRED_REPORT_FIELDS) {
        if (!(key in report))
            errors.push(`missing field: ${key}`);
    }
    if (typeof report.ok !== "boolean")
        errors.push("ok must be boolean");
    if (!ERROR_TYPES.includes(report.errorType))
        errors.push("invalid errorType");
    if (report.ok === true && report.errorType !== "none")
        errors.push("successful reports must use errorType=none");
    if (report.ok === false && report.errorType === "none")
        errors.push("failed reports must include an error type");
    if ("errorStatusCode" in report && report.errorStatusCode !== null) {
        if (!Number.isInteger(report.errorStatusCode) || Number(report.errorStatusCode) < 400 || Number(report.errorStatusCode) > 599) {
            errors.push("invalid errorStatusCode");
        }
    }
    if ("errorHint" in report && report.errorHint !== null) {
        if (typeof report.errorHint !== "string" || report.errorHint.length > 160 || /[\u0000-\u001f\u007f]/.test(report.errorHint)) {
            errors.push("invalid errorHint");
        }
    }
    if (report.ok === true && report.errorStatusCode != null)
        errors.push("successful reports must use errorStatusCode=null");
    if (report.ok === true && report.errorHint != null)
        errors.push("successful reports must use errorHint=null");
    if (!MODEL_CLASSES.includes(report.modelClass))
        errors.push("invalid modelClass");
    if (!LATENCY_BUCKETS.includes(report.latencyBucket))
        errors.push("invalid latencyBucket");
    if (!Number.isInteger(report.timeBucket) || Number(report.timeBucket) < 25000000)
        errors.push("invalid timeBucket");
    if (typeof report.pluginVersion !== "string" || !/^\d+\.\d+\.\d+/.test(report.pluginVersion))
        errors.push("invalid pluginVersion");
    if (typeof report.anonymousId !== "string" || !/^anon_[A-Za-z0-9_-]{16,80}$/.test(report.anonymousId))
        errors.push("invalid anonymousId");
    if (typeof report.sampleRate !== "number" || !Number.isFinite(report.sampleRate) || report.sampleRate <= 0 || report.sampleRate > 1)
        errors.push("invalid sampleRate");
    if (report.targetMatched !== true)
        errors.push("targetMatched must be true");
    if ("targetHost" in report && normalizeTargetHost(report.targetHost) === null)
        errors.push("invalid targetHost");
    return { ok: errors.length === 0, errors };
}
export function sanitizeRemoteConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { ...DEFAULT_REMOTE_CONFIG };
    const config = value;
    return {
        reportingEnabled: config.reportingEnabled !== false,
        apiBaseUrl: typeof config.apiBaseUrl === "string" && config.apiBaseUrl.startsWith("http") ? config.apiBaseUrl : DEFAULT_API_BASE_URL,
        targetBaseUrlHosts: normalizeTargetHosts(config.targetBaseUrlHosts),
        sampleRateSuccess: clampRate(config.sampleRateSuccess, DEFAULT_REMOTE_CONFIG.sampleRateSuccess),
        sampleRateFailure: clampRate(config.sampleRateFailure, DEFAULT_REMOTE_CONFIG.sampleRateFailure),
        minPluginVersion: typeof config.minPluginVersion === "string" ? config.minPluginVersion : DEFAULT_REMOTE_CONFIG.minPluginVersion,
        statusWindows: Array.isArray(config.statusWindows)
            ? config.statusWindows.filter((item) => typeof item === "string" && STATUS_WINDOWS.includes(item))
            : DEFAULT_REMOTE_CONFIG.statusWindows
    };
}
function clampRate(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.max(0, Math.min(1, number));
}
