import { SITE_CONFIG, SITE_ENDPOINTS } from "./site-config.mjs";

export const PLUGIN_VERSION = "0.3.1";

export const TARGET_HOSTS = Object.freeze(SITE_ENDPOINTS.map((endpoint) => endpoint.host));

export const DEFAULT_API_BASE_URL = SITE_CONFIG.defaultApiBaseUrl;
export const DEFAULT_CONFIG_URL = `${DEFAULT_API_BASE_URL.replace(/\/+$/, "")}/config.json`;
export const LOCAL_DAILY_REPORT_LIMIT = 500;
export const SERVER_DAILY_REPORT_SOFT_LIMIT = 500;
export const SERVER_DAILY_REPORT_HARD_LIMIT = 1000;
export const SERVER_DAILY_REPORT_SAMPLE_RATE = 0.1;

export const ERROR_TYPES = Object.freeze([
  "none",
  "server_error",
  "rate_limited",
  "network_error",
  "auth_error",
  "timeout",
  "unknown"
] as const);

export const MODEL_CLASSES = Object.freeze(["haiku", "sonnet", "opus", "fable", "gpt-5.5", "unknown"] as const);
export const STATUS_MODEL_ORDER = Object.freeze(["fable", "opus", "sonnet", "haiku", "gpt-5.5", "unknown"] as const);

export const CLIENTS = Object.freeze(["claude-code", "codex"] as const);

// Ordered keyword table: first substring hit wins. Extend by adding a row;
// more specific keywords must come before their prefixes.
export const MODEL_CLASS_MATCHERS = Object.freeze([
  Object.freeze({ keyword: "gpt-5.5", modelClass: "gpt-5.5" }),
  Object.freeze({ keyword: "fable", modelClass: "fable" }),
  Object.freeze({ keyword: "haiku", modelClass: "haiku" }),
  Object.freeze({ keyword: "sonnet", modelClass: "sonnet" }),
  Object.freeze({ keyword: "opus", modelClass: "opus" })
] as const satisfies ReadonlyArray<{ keyword: string; modelClass: string }>);

export const ASSISTANT_START_BUCKETS = Object.freeze([
  "lt_3s",
  "3_10s",
  "10_30s",
  "30_60s",
  "gt_60s",
  "unknown"
] as const);

export const STATUS_ASSISTANT_START_COLUMNS = Object.freeze([
  ["lt_3s", "assistant_start_lt_3s"],
  ["3_10s", "assistant_start_3_10s"],
  ["10_30s", "assistant_start_10_30s"],
  ["30_60s", "assistant_start_30_60s"],
  ["gt_60s", "assistant_start_gt_60s"],
  ["unknown", "assistant_start_unknown"]
] as const);

export const STATUS_ERROR_COLUMNS = Object.freeze([
  ["server_error", "err_server_error"],
  ["rate_limited", "err_rate_limited"],
  ["network_error", "err_network_error"],
  ["auth_error", "err_auth_error"],
  ["timeout", "err_timeout"],
  ["unknown", "err_unknown"]
] as const);

export const STATUS_WINDOW_SPECS = Object.freeze({
  "5m": { minutes: 5, bucketMinutes: 1, bucketCount: 5 },
  "15m": { minutes: 15, bucketMinutes: 1, bucketCount: 15 },
  "60m": { minutes: 60, bucketMinutes: 5, bucketCount: 12 },
  "90m": { minutes: 90, bucketMinutes: 5, bucketCount: 18 },
  "24h": { minutes: 24 * 60, bucketMinutes: 60, bucketCount: 24 },
  "7d": { minutes: 7 * 24 * 60, bucketMinutes: 6 * 60, bucketCount: 28 },
  "30d": { minutes: 30 * 24 * 60, bucketMinutes: 24 * 60, bucketCount: 30 }
} as const);

export const STATUS_STATE_THRESHOLDS = Object.freeze({
  insufficient_data: "sampleCount < 5",
  down: "availability < 30%",
  unstable: "30% <= availability < 80%",
  available: "availability >= 80%"
} as const);

export const REPORT_FIELDS = Object.freeze([
  "ok",
  "errorType",
  "errorStatusCode",
  "errorHint",
  "client",
  "modelClass",
  "assistantStartBucket",
  "timeBucket",
  "pluginVersion",
  "anonymousId",
  "sampleRate",
  "targetMatched",
  "targetHost"
] as const);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  "ok",
  "errorType",
  "client",
  "modelClass",
  "assistantStartBucket",
  "timeBucket",
  "pluginVersion",
  "anonymousId",
  "sampleRate",
  "targetMatched",
  "targetHost"
] as const);

export const STATUS_WINDOWS = Object.freeze(Object.keys(STATUS_WINDOW_SPECS) as Array<keyof typeof STATUS_WINDOW_SPECS>);

export type ErrorType = (typeof ERROR_TYPES)[number];
export type ModelClass = (typeof MODEL_CLASSES)[number];
export type Client = (typeof CLIENTS)[number];
export type AssistantStartBucket = (typeof ASSISTANT_START_BUCKETS)[number];
export type TargetHost = (typeof TARGET_HOSTS)[number];
export type ReportField = (typeof REPORT_FIELDS)[number];
export type StatusWindow = (typeof STATUS_WINDOWS)[number];

export interface ReportPayload {
  ok: boolean;
  errorType: ErrorType;
  errorStatusCode?: number | null;
  errorHint?: string | null;
  client: Client;
  modelClass: ModelClass;
  assistantStartBucket: AssistantStartBucket;
  timeBucket: number;
  pluginVersion: string;
  anonymousId: string;
  sampleRate: number;
  targetMatched: true;
  targetHost: TargetHost;
}

export interface RemoteConfig {
  reportingEnabled: boolean;
  apiBaseUrl: string;
  targetBaseUrlHosts: readonly string[];
  sampleRateSuccess: number;
  sampleRateFailure: number;
  minPluginVersion: string;
  latestPluginVersion: string;
  statusWindows: readonly StatusWindow[];
}

type LooseInput = Record<string, any>;

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = Object.freeze({
  reportingEnabled: true,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  targetBaseUrlHosts: TARGET_HOSTS,
  sampleRateSuccess: 1,
  sampleRateFailure: 1,
  minPluginVersion: PLUGIN_VERSION,
  latestPluginVersion: PLUGIN_VERSION,
  statusWindows: ["60m", "24h", "7d", "30d"] as const
});

export function normalizeHostFromBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeTargetHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [...TARGET_HOSTS];
  const hosts = value
    .map(normalizeTargetHost)
    .filter((host): host is TargetHost => host !== null);
  return hosts.length > 0 ? [...new Set(hosts)] : [...TARGET_HOSTS];
}

export function normalizeTargetHost(value: unknown): TargetHost | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  return (TARGET_HOSTS as readonly string[]).includes(host) ? host as TargetHost : null;
}

export function matchTargetBaseUrl(baseUrl: unknown, targetHosts: unknown = TARGET_HOSTS): { matched: boolean; host: string | null } {
  const host = normalizeHostFromBaseUrl(baseUrl);
  if (!host) return { matched: false, host: null };
  const normalizedTargets = normalizeTargetHosts(targetHosts);
  return { matched: normalizedTargets.includes(host), host };
}

export function getTodayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createTimeBucket(nowMs = Date.now()) {
  return Math.floor(nowMs / 60000);
}

export function isPluginVersionNewer(latestPluginVersion: string, currentPluginVersion = PLUGIN_VERSION): boolean {
  return comparePluginVersions(latestPluginVersion, currentPluginVersion) > 0;
}

export function comparePluginVersions(left: string, right: string): number {
  const leftParts = parsePluginVersion(left);
  const rightParts = parsePluginVersion(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < leftParts.length; index += 1) {
    const diff = leftParts[index]! - rightParts[index]!;
    if (diff !== 0) return diff;
  }

  return 0;
}

function parsePluginVersion(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function bucketAssistantStart(durationMs: unknown): AssistantStartBucket {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  if (durationMs < 3000) return "lt_3s";
  if (durationMs < 10000) return "3_10s";
  if (durationMs < 30000) return "10_30s";
  if (durationMs < 60000) return "30_60s";
  return "gt_60s";
}

export function classifyModel(input: LooseInput | null | undefined, { includeEnv = true }: { includeEnv?: boolean } = {}): ModelClass {
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
  if (inputModelClass !== "unknown" || !includeEnv) return inputModelClass;

  return classifyModelText([
    globalThis.process?.env?.ANTHROPIC_MODEL,
    globalThis.process?.env?.CLAUDE_MODEL
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase());
}

function classifyModelText(raw: string): ModelClass {
  for (const matcher of MODEL_CLASS_MATCHERS) {
    if (raw.includes(matcher.keyword)) return matcher.modelClass as ModelClass;
  }
  return "unknown";
}

export function normalizeClient(value: unknown): Client | null {
  if (typeof value !== "string") return null;
  return (CLIENTS as readonly string[]).includes(value) ? value as Client : null;
}

export function classifyError(input: LooseInput | null | undefined): ErrorType {
  const raw = collectErrorParts(input).join(" ").toLowerCase();

  if (raw.includes("rate") || raw.includes("rate_limit") || raw.includes("429") || raw.includes("quota")) return "rate_limited";
  if (raw.includes("auth") || raw.includes("unauthorized") || raw.includes("401") || raw.includes("403")) return "auth_error";
  if (raw.includes("timeout") || raw.includes("timed out") || raw.includes("etimedout")) return "timeout";
  if (raw.includes("network") || raw.includes("connection") || raw.includes("econn") || raw.includes("enotfound") || raw.includes("fetch failed")) return "network_error";
  if (raw.includes("api_error") || raw.includes("overloaded") || raw.includes("500") || raw.includes("502") || raw.includes("503") || raw.includes("504") || raw.includes("server")) return "server_error";
  return "unknown";
}

export function extractErrorStatusCode(input: LooseInput | null | undefined): number | null {
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
    if (statusCode !== null) return statusCode;
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

export function createErrorHint(input: LooseInput | null | undefined): string | null {
  const candidates = [
    input?.error_details?.message,
    input?.error?.message,
    typeof input?.error_details === "string" ? input.error_details : null,
    typeof input?.error === "string" ? input.error : null
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeErrorHint(candidate);
    if (sanitized) return sanitized;
  }
  return null;
}

export function sanitizeErrorHint(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

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
  if (!text) return null;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function collectErrorParts(input: LooseInput | null | undefined): string[] {
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

function parseHttpStatusCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[45]\d{2}$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function pickSampleRate(ok: boolean, config: Partial<RemoteConfig> | null | undefined): number {
  const key = ok ? "sampleRateSuccess" : "sampleRateFailure";
  const value = Number(config?.[key]);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export function shouldSample(sampleRate: number, random: () => number = Math.random): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return random() < sampleRate;
}

export function validateReportPayload(payload: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const fieldSet = new Set<string>(REPORT_FIELDS);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be an object"] };
  }

  const report = payload as Partial<ReportPayload> & Record<string, unknown>;

  for (const key of Object.keys(report)) {
    if (!fieldSet.has(key)) errors.push(`unknown field: ${key}`);
  }

  for (const key of REQUIRED_REPORT_FIELDS) {
    if (!(key in report)) errors.push(`missing field: ${key}`);
  }

  if (typeof report.ok !== "boolean") errors.push("ok must be boolean");
  if (!ERROR_TYPES.includes(report.errorType as ErrorType)) errors.push("invalid errorType");
  if (report.ok === true && report.errorType !== "none") errors.push("successful reports must use errorType=none");
  if (report.ok === false && report.errorType === "none") errors.push("failed reports must include an error type");
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
  if (report.ok === true && report.errorStatusCode != null) errors.push("successful reports must use errorStatusCode=null");
  if (report.ok === true && report.errorHint != null) errors.push("successful reports must use errorHint=null");
  if (normalizeClient(report.client) === null) errors.push("invalid client");
  if (!MODEL_CLASSES.includes(report.modelClass as ModelClass)) errors.push("invalid modelClass");
  if (!ASSISTANT_START_BUCKETS.includes(report.assistantStartBucket as AssistantStartBucket)) {
    errors.push("invalid assistantStartBucket");
  }
  if (!Number.isInteger(report.timeBucket) || Number(report.timeBucket) < 25000000) errors.push("invalid timeBucket");
  if (typeof report.pluginVersion !== "string" || !/^\d+\.\d+\.\d+/.test(report.pluginVersion)) errors.push("invalid pluginVersion");
  if (typeof report.anonymousId !== "string" || !/^anon_[A-Za-z0-9_-]{16,80}$/.test(report.anonymousId)) errors.push("invalid anonymousId");
  if (typeof report.sampleRate !== "number" || !Number.isFinite(report.sampleRate) || report.sampleRate <= 0 || report.sampleRate > 1) errors.push("invalid sampleRate");
  if (report.targetMatched !== true) errors.push("targetMatched must be true");
  if ("targetHost" in report && normalizeTargetHost(report.targetHost) === null) errors.push("invalid targetHost");

  return { ok: errors.length === 0, errors };
}

export function sanitizeRemoteConfig(value: unknown): RemoteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_REMOTE_CONFIG };
  const config = value as Record<string, unknown>;
  return {
    reportingEnabled: config.reportingEnabled !== false,
    apiBaseUrl: typeof config.apiBaseUrl === "string" && config.apiBaseUrl.startsWith("http") ? config.apiBaseUrl : DEFAULT_API_BASE_URL,
    targetBaseUrlHosts: normalizeTargetHosts(config.targetBaseUrlHosts),
    sampleRateSuccess: clampRate(config.sampleRateSuccess, DEFAULT_REMOTE_CONFIG.sampleRateSuccess),
    sampleRateFailure: clampRate(config.sampleRateFailure, DEFAULT_REMOTE_CONFIG.sampleRateFailure),
    minPluginVersion: typeof config.minPluginVersion === "string" ? config.minPluginVersion : DEFAULT_REMOTE_CONFIG.minPluginVersion,
    latestPluginVersion: normalizePluginVersion(config.latestPluginVersion, DEFAULT_REMOTE_CONFIG.latestPluginVersion),
    statusWindows: Array.isArray(config.statusWindows)
      ? config.statusWindows.filter((item): item is StatusWindow => typeof item === "string" && STATUS_WINDOWS.includes(item as StatusWindow))
      : DEFAULT_REMOTE_CONFIG.statusWindows
  };
}

function normalizePluginVersion(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : fallback;
}

function clampRate(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}
