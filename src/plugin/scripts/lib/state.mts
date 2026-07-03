import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  LOCAL_DAILY_REPORT_LIMIT,
  MODEL_CLASSES,
  PLUGIN_VERSION,
  createAnonymousId,
  getTodayKey,
  isPluginVersionNewer,
  normalizeTargetHost,
  validateReportPayload,
  type ModelClass,
  type ReportPayload,
  type TargetHost
} from "./policy.mjs";

const STATE_VERSION = 1;
const STATE_DIR_NAME = "anyrouter-status-monitor";
const STATE_FILE_NAME = "state.json";
const STATUS_CACHE_FILE_NAME = "status-cache.json";
const CONTRIBUTION_RETENTION_DAYS = 120;
const TURN_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AnonymousState {
  day: string;
  id: string;
}

export interface TurnState {
  startedAtMs?: number;
  transcriptStartOffset?: number;
  targetMatched?: boolean;
  turnId?: string;
  modelClass?: ModelClass;
  promptCount?: number;
  updatedAtMs?: number;
}

export interface UpdateReminderState {
  latestPluginVersion: string;
  remindedAtMs: number;
}

export type LastDecisionKind = "reported" | "skipped" | "post_failed";

export type LastDecisionEventName = "Stop" | "StopFailure" | "UserPromptSubmit" | "SessionStart";

export interface LastDecision {
  at: string;
  eventName: LastDecisionEventName;
  kind: LastDecisionKind;
  reason: string | null;
  modelClass?: ModelClass;
  targetHost?: TargetHost;
  postStatusCode?: number;
}

export interface PluginState {
  version: number;
  anonymous: AnonymousState | null;
  pending: Record<string, TurnState>;
  sessions: Record<string, TurnState>;
  contributions: Record<string, number>;
  updateReminder: UpdateReminderState | null;
  lastPayload: ReportPayload | null;
  lastReportAt: string | null;
  lastDecision: LastDecision | null;
}

export interface StatusCache {
  apiBaseUrl: string;
  cacheScope: string;
  fetchedAtMs: number;
  status: Record<string, unknown> | null;
}

export function getStatePath(): string {
  return join(getPluginStateDir(), STATE_FILE_NAME);
}

export function getStatusCachePath(): string {
  return join(getPluginStateDir(), STATUS_CACHE_FILE_NAME);
}

export function getPluginStateDir(): string {
  return join(getStateRoot(), STATE_DIR_NAME);
}

export async function loadState(): Promise<PluginState> {
  const path = getStatePath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return normalizeState({});
  }
}

export async function loadStatusCache(): Promise<StatusCache | null> {
  try {
    const raw = await readFile(getStatusCachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.apiBaseUrl !== "string") return null;
    if (typeof parsed.cacheScope !== "string") return null;
    if (typeof parsed.fetchedAtMs !== "number" || !Number.isFinite(parsed.fetchedAtMs)) return null;
    if (parsed.status !== null && !isRecord(parsed.status)) return null;
    return {
      apiBaseUrl: parsed.apiBaseUrl,
      cacheScope: parsed.cacheScope,
      fetchedAtMs: parsed.fetchedAtMs,
      status: parsed.status
    };
  } catch {
    return null;
  }
}

export async function saveStatusCache(cache: StatusCache): Promise<void> {
  const path = getStatusCachePath();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(tmpPath, path);
}

export async function saveState(state: PluginState): Promise<void> {
  const path = getStatePath();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

export async function getDailyAnonymousId(state: PluginState, now = new Date()): Promise<string> {
  const today = getTodayKey(now);
  if (state.anonymous?.day === today && typeof state.anonymous.id === "string") {
    return state.anonymous.id;
  }
  state.anonymous = { day: today, id: createAnonymousId() };
  return state.anonymous.id;
}

export function incrementContribution(state: PluginState, now = new Date()): void {
  const today = getTodayKey(now);
  state.contributions[today] = (state.contributions[today] ?? 0) + 1;
}

export function getTodayContributions(state: PluginState, now = new Date()): number {
  return state.contributions[getTodayKey(now)] ?? 0;
}

export function hasReachedDailyReportLimit(state: PluginState, now = new Date()): boolean {
  return getTodayContributions(state, now) >= LOCAL_DAILY_REPORT_LIMIT;
}

export function shouldRemindPluginUpdate(state: PluginState, latestPluginVersion: string, nowMs = Date.now()): boolean {
  if (!isPluginVersionNewer(latestPluginVersion, PLUGIN_VERSION)) return false;
  const reminder = state.updateReminder;
  if (!reminder || reminder.latestPluginVersion !== latestPluginVersion) return true;
  return reminder.remindedAtMs + UPDATE_REMINDER_INTERVAL_MS <= nowMs;
}

export function recordPluginUpdateReminder(state: PluginState, latestPluginVersion: string, nowMs = Date.now()): void {
  state.updateReminder = {
    latestPluginVersion,
    remindedAtMs: nowMs
  };
}

function normalizeState(value: unknown, now = new Date()): PluginState {
  const record = isRecord(value) ? value : {};
  const nowMs = now.getTime();
  return {
    version: STATE_VERSION,
    anonymous: normalizeAnonymous(record.anonymous),
    pending: normalizeTurnMap(record.pending, nowMs),
    sessions: normalizeTurnMap(record.sessions, nowMs),
    contributions: normalizeContributions(record.contributions, now),
    updateReminder: normalizeUpdateReminder(record.updateReminder),
    lastPayload: normalizeLastPayload(record.lastPayload),
    lastReportAt: typeof record.lastReportAt === "string" ? record.lastReportAt : null,
    lastDecision: normalizeLastDecision(record.lastDecision)
  };
}

function normalizeAnonymous(value: unknown): AnonymousState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.day !== "string" || typeof record.id !== "string") return null;
  return { day: record.day, id: record.id };
}

function normalizeLastPayload(value: unknown): ReportPayload | null {
  if (!isRecord(value)) return null;
  return validateReportPayload(value).ok ? value as unknown as ReportPayload : null;
}

function normalizeUpdateReminder(value: unknown): UpdateReminderState | null {
  if (!isRecord(value)) return null;
  if (typeof value.latestPluginVersion !== "string") return null;
  if (typeof value.remindedAtMs !== "number" || !Number.isFinite(value.remindedAtMs)) return null;
  return {
    latestPluginVersion: value.latestPluginVersion,
    remindedAtMs: value.remindedAtMs
  };
}

const LAST_DECISION_EVENT_NAMES: readonly LastDecisionEventName[] = ["Stop", "StopFailure", "UserPromptSubmit", "SessionStart"];

function normalizeLastDecision(value: unknown): LastDecision | null {
  if (!isRecord(value)) return null;
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return null;
  if (!LAST_DECISION_EVENT_NAMES.includes(value.eventName as LastDecisionEventName)) return null;
  if (value.kind !== "reported" && value.kind !== "skipped" && value.kind !== "post_failed") return null;
  if (value.reason !== null && !isReasonCode(value.reason)) return null;

  const result: LastDecision = {
    at: value.at,
    eventName: value.eventName as LastDecisionEventName,
    kind: value.kind,
    reason: value.reason
  };

  if (typeof value.modelClass === "string" && MODEL_CLASSES.includes(value.modelClass as ModelClass)) {
    result.modelClass = value.modelClass as ModelClass;
  }

  const targetHost = normalizeTargetHost(value.targetHost);
  if (targetHost) result.targetHost = targetHost;

  if (typeof value.postStatusCode === "number" && Number.isInteger(value.postStatusCode) && value.postStatusCode >= 400 && value.postStatusCode <= 599) {
    result.postStatusCode = value.postStatusCode;
  }

  return result;
}

function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value);
}

function normalizeTurnMap(value: unknown, nowMs: number): Record<string, TurnState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TurnState> = {};
  const cutoffMs = nowMs - TURN_STATE_RETENTION_MS;
  for (const [key, item] of Object.entries(value)) {
    const turn = normalizeTurnState(item);
    if (!turn) continue;
    const updatedAtMs = getTurnUpdatedAtMs(turn);
    if (updatedAtMs === null || updatedAtMs < cutoffMs) continue;
    result[key] = turn;
  }
  return result;
}

function normalizeTurnState(value: unknown): TurnState | null {
  if (!isRecord(value)) return null;
  const result: TurnState = {};
  if (typeof value.startedAtMs === "number" && Number.isFinite(value.startedAtMs)) result.startedAtMs = value.startedAtMs;
  if (typeof value.transcriptStartOffset === "number" && Number.isFinite(value.transcriptStartOffset)) {
    result.transcriptStartOffset = value.transcriptStartOffset;
  }
  if (typeof value.updatedAtMs === "number" && Number.isFinite(value.updatedAtMs)) result.updatedAtMs = value.updatedAtMs;
  if (typeof value.targetMatched === "boolean") result.targetMatched = value.targetMatched;
  if (typeof value.turnId === "string" && value.turnId !== "" && value.turnId.length <= 128) result.turnId = value.turnId;
  if (typeof value.modelClass === "string" && MODEL_CLASSES.includes(value.modelClass as ModelClass)) {
    result.modelClass = value.modelClass as ModelClass;
  }
  if (typeof value.promptCount === "number" && Number.isInteger(value.promptCount) && value.promptCount >= 0) {
    result.promptCount = value.promptCount;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function getTurnUpdatedAtMs(turn: TurnState): number | null {
  const values = [turn.updatedAtMs, turn.startedAtMs].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function normalizeContributions(value: unknown, now: Date): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  const cutoffKey = getRetentionCutoffKey(now);
  for (const [key, count] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < cutoffKey) continue;
    if (typeof count === "number" && Number.isFinite(count)) result[key] = count;
  }
  return result;
}

function getRetentionCutoffKey(now: Date): string {
  return getTodayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - CONTRIBUTION_RETENTION_DAYS + 1)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getStateRoot(): string {
  return (
    process.env.ANYROUTER_STATUS_STATE_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    process.env.XDG_STATE_HOME ||
    process.env.LOCALAPPDATA ||
    process.env.APPDATA ||
    join(homedir(), ".local", "state")
  );
}
