import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createAnonymousId, getTodayKey } from "./policy.mjs";
const STATE_VERSION = 1;
const STATE_DIR_NAME = "anyrouter-status-monitor";
const STATE_FILE_NAME = "state.json";
const STATUS_CACHE_FILE_NAME = "status-cache.json";
export function getStatePath() {
    return join(getStateRoot(), STATE_DIR_NAME, STATE_FILE_NAME);
}
export function getStatusCachePath() {
    return join(getStateRoot(), STATE_DIR_NAME, STATUS_CACHE_FILE_NAME);
}
export async function loadState() {
    const path = getStatePath();
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        return normalizeState(parsed);
    }
    catch {
        return loadLegacyPluginDataState(path);
    }
}
export async function loadStatusCache() {
    try {
        const raw = await readFile(getStatusCachePath(), "utf8");
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed))
            return null;
        if (typeof parsed.apiBaseUrl !== "string")
            return null;
        if (typeof parsed.fetchedAtMs !== "number" || !Number.isFinite(parsed.fetchedAtMs))
            return null;
        if (parsed.status !== null && !isRecord(parsed.status))
            return null;
        return {
            apiBaseUrl: parsed.apiBaseUrl,
            fetchedAtMs: parsed.fetchedAtMs,
            status: parsed.status
        };
    }
    catch {
        return null;
    }
}
export async function saveStatusCache(cache) {
    const path = getStatusCachePath();
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(cache)}\n`, "utf8");
    await rename(tmpPath, path);
}
export async function saveState(state) {
    const path = getStatePath();
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
    await rename(tmpPath, path);
}
export async function getDailyAnonymousId(state, now = new Date()) {
    const today = getTodayKey(now);
    if (state.anonymous?.day === today && typeof state.anonymous.id === "string") {
        return state.anonymous.id;
    }
    state.anonymous = { day: today, id: createAnonymousId() };
    return state.anonymous.id;
}
export function incrementContribution(state, now = new Date()) {
    const today = getTodayKey(now);
    state.contributions[today] = (state.contributions[today] ?? 0) + 1;
}
export function getTodayContributions(state, now = new Date()) {
    return state.contributions[getTodayKey(now)] ?? 0;
}
function normalizeState(value) {
    const record = isRecord(value) ? value : {};
    return {
        version: STATE_VERSION,
        anonymous: normalizeAnonymous(record.anonymous),
        pending: normalizeTurnMap(record.pending),
        sessions: normalizeTurnMap(record.sessions),
        contributions: normalizeContributions(record.contributions),
        lastPayload: isRecord(record.lastPayload) ? record.lastPayload : null,
        lastReportAt: typeof record.lastReportAt === "string" ? record.lastReportAt : null
    };
}
function normalizeAnonymous(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    if (typeof record.day !== "string" || typeof record.id !== "string")
        return null;
    return { day: record.day, id: record.id };
}
function normalizeTurnMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return { ...value };
}
function normalizeContributions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const result = {};
    for (const [key, count] of Object.entries(value)) {
        if (typeof count === "number" && Number.isFinite(count))
            result[key] = count;
    }
    return result;
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function getStateRoot() {
    return (process.env.ANYROUTER_STATUS_STATE_DIR ||
        process.env.XDG_STATE_HOME ||
        process.env.LOCALAPPDATA ||
        process.env.APPDATA ||
        join(homedir(), ".local", "state"));
}
async function loadLegacyPluginDataState(primaryPath) {
    const legacyRoot = process.env.CLAUDE_PLUGIN_DATA;
    if (process.env.ANYROUTER_STATUS_STATE_DIR || !legacyRoot)
        return normalizeState({});
    const legacyPath = join(legacyRoot, STATE_DIR_NAME, STATE_FILE_NAME);
    if (legacyPath === primaryPath)
        return normalizeState({});
    try {
        const raw = await readFile(legacyPath, "utf8");
        return normalizeState(JSON.parse(raw));
    }
    catch {
        return normalizeState({});
    }
}
