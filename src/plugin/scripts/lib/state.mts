import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_ID } from "./site-config.mjs";
import {
  LOCAL_DAILY_REPORT_LIMIT,
  MODEL_CLASSES,
  PLUGIN_VERSION,
  createAnonymousId,
  getTodayKey,
  isPluginVersionNewer,
  normalizeTargetHost,
  validateReportPayload,
  type Client,
  type ModelClass,
  type ReportPayload,
  type TargetHost
} from "./policy.mjs";

const STATE_VERSION = 2;
const STATE_DIR_NAME = PLUGIN_ID;
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const STATUS_CACHE_FILE_NAME = "status-cache.json";
const CONTRIBUTION_RETENTION_DAYS = 120;
const TURN_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_LOCK_RETRY_MS = 40;
const STATE_LOCK_TIMEOUT_MS = 45_000;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_HEARTBEAT_MS = 5_000;

export interface AnonymousState {
  day: string;
  id: string;
}

export interface PendingTurn {
  client: Client;
  settlementId: string;
  startedAtMs: number;
  targetMatched: boolean;
  transcriptStartOffset?: number;
  transcriptPath?: string;
  transcriptKey?: string;
  turnId?: string;
  modelClass?: ModelClass;
}

export interface SessionState {
  modelClass?: ModelClass;
  transcriptKey?: string;
  promptCount: number;
  updatedAtMs: number;
}

export interface UpdateReminderState {
  latestPluginVersion: string;
  remindedAtMs: number;
}

export type LastDecisionKind = "reported" | "skipped" | "post_failed";

export type LastDecisionEventName = "Stop" | "StopFailure" | "UserPromptSubmit" | "SessionStart" | "CodexWatcher";

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
  pending: Record<string, PendingTurn>;
  sessions: Record<string, SessionState>;
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

export function getStateLockPath(): string {
  return join(getPluginStateDir(), STATE_LOCK_FILE_NAME);
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

export async function withLockedState<T>(run: (state: PluginState) => Promise<T>): Promise<T> {
  const release = await acquireStateLock();
  try {
    const state = await loadState();
    const result = await run(state);
    await saveState(state);
    return result;
  } finally {
    await release();
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

async function saveState(state: PluginState): Promise<void> {
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
  if (!isRecord(value) || value.version !== STATE_VERSION) return createEmptyState();
  const record = value;
  const nowMs = now.getTime();
  return {
    version: STATE_VERSION,
    anonymous: normalizeAnonymous(record.anonymous),
    pending: normalizePendingMap(record.pending, nowMs),
    sessions: normalizeSessionMap(record.sessions, nowMs),
    contributions: normalizeContributions(record.contributions, now),
    updateReminder: normalizeUpdateReminder(record.updateReminder),
    lastPayload: normalizeLastPayload(record.lastPayload),
    lastReportAt: typeof record.lastReportAt === "string" ? record.lastReportAt : null,
    lastDecision: normalizeLastDecision(record.lastDecision)
  };
}

function createEmptyState(): PluginState {
  return {
    version: STATE_VERSION,
    anonymous: null,
    pending: {},
    sessions: {},
    contributions: {},
    updateReminder: null,
    lastPayload: null,
    lastReportAt: null,
    lastDecision: null
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

const LAST_DECISION_EVENT_NAMES: readonly LastDecisionEventName[] = [
  "Stop",
  "StopFailure",
  "UserPromptSubmit",
  "SessionStart",
  "CodexWatcher"
];

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

function normalizePendingMap(value: unknown, nowMs: number): Record<string, PendingTurn> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, PendingTurn> = {};
  const cutoffMs = nowMs - TURN_STATE_RETENTION_MS;
  for (const [key, item] of Object.entries(value)) {
    const pending = normalizePendingTurn(item);
    if (!pending || pending.startedAtMs < cutoffMs) continue;
    result[key] = pending;
  }
  return result;
}

function normalizePendingTurn(value: unknown): PendingTurn | null {
  if (!isRecord(value)) return null;
  if (value.client !== "claude-code" && value.client !== "codex") return null;
  if (typeof value.settlementId !== "string" || !isSettlementId(value.settlementId)) return null;
  if (typeof value.startedAtMs !== "number" || !Number.isFinite(value.startedAtMs)) return null;
  if (typeof value.targetMatched !== "boolean") return null;

  const result: PendingTurn = {
    client: value.client,
    settlementId: value.settlementId,
    startedAtMs: value.startedAtMs,
    targetMatched: value.targetMatched
  };
  if (typeof value.transcriptStartOffset === "number" && Number.isFinite(value.transcriptStartOffset)) {
    result.transcriptStartOffset = value.transcriptStartOffset;
  }
  if (typeof value.transcriptPath === "string" && value.transcriptPath !== "") result.transcriptPath = value.transcriptPath;
  if (typeof value.transcriptKey === "string" && /^[a-f0-9]{24}$/.test(value.transcriptKey)) {
    result.transcriptKey = value.transcriptKey;
  }
  if (typeof value.turnId === "string" && value.turnId !== "" && value.turnId.length <= 128) result.turnId = value.turnId;
  if (typeof value.modelClass === "string" && MODEL_CLASSES.includes(value.modelClass as ModelClass)) {
    result.modelClass = value.modelClass as ModelClass;
  }
  return result;
}

function normalizeSessionMap(value: unknown, nowMs: number): Record<string, SessionState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, SessionState> = {};
  const cutoffMs = nowMs - TURN_STATE_RETENTION_MS;
  for (const [key, item] of Object.entries(value)) {
    const session = normalizeSessionState(item);
    if (!session || session.updatedAtMs < cutoffMs) continue;
    result[key] = session;
  }
  return result;
}

function normalizeSessionState(value: unknown): SessionState | null {
  if (!isRecord(value)) return null;
  if (typeof value.promptCount !== "number" || !Number.isInteger(value.promptCount) || value.promptCount < 0) return null;
  if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) return null;
  const result: SessionState = {
    promptCount: value.promptCount,
    updatedAtMs: value.updatedAtMs
  };
  if (typeof value.transcriptKey === "string" && /^[a-f0-9]{24}$/.test(value.transcriptKey)) {
    result.transcriptKey = value.transcriptKey;
  }
  if (typeof value.modelClass === "string" && MODEL_CLASSES.includes(value.modelClass as ModelClass)) {
    result.modelClass = value.modelClass as ModelClass;
  }
  return result;
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

function isSettlementId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function acquireStateLock(): Promise<() => Promise<void>> {
  const lockPath = getStateLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAtMs = Date.now();
  const token = `${process.pid}:${randomUUID()}`;

  while (true) {
    let handle: FileHandle | null = null;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(token, "utf8");
      const heartbeat = setInterval(() => {
        void handle?.utimes(new Date(), new Date()).catch(() => undefined);
      }, STATE_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await handle?.close().catch(() => undefined);
        await releaseOwnedLock(lockPath, token);
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isAlreadyExistsError(error)) throw error;
      await removeStaleLock(lockPath);
      if (Date.now() - startedAtMs >= STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out acquiring plugin state lock: ${lockPath}`);
      }
      await sleep(STATE_LOCK_RETRY_MS);
    }
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await removeOwnedLock(lockPath, token);
      return;
    } catch {
      if (attempt < 2) await sleep(STATE_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < STATE_LOCK_STALE_MS) return;
    await unlink(lockPath);
  } catch (error) {
    if (!isNotFoundError(error) && !isPermissionError(error)) throw error;
  }
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readFile(lockPath, "utf8");
    if (current !== token) return;
    await unlink(lockPath);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStateRoot(): string {
  return (
    process.env.ROUTER_VITALS_STATE_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    process.env.XDG_STATE_HOME ||
    process.env.LOCALAPPDATA ||
    process.env.APPDATA ||
    join(homedir(), ".local", "state")
  );
}
