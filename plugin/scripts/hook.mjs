#!/usr/bin/env node
import { open } from "node:fs/promises";
import { loadRemoteConfig } from "./lib/config.mjs";
import { PLUGIN_VERSION, bucketLatency, classifyError, classifyModel, createErrorHint, createTimeBucket, extractErrorStatusCode, hashLocalSessionId, matchTargetBaseUrl, normalizeTargetHost, pickSampleRate, shouldSample, validateReportPayload } from "./lib/policy.mjs";
import { getDailyAnonymousId, hasReachedDailyReportLimit, incrementContribution, loadState, saveState } from "./lib/state.mjs";
const eventName = process.argv[2] || "";
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
main().catch(() => {
    process.exit(0);
});
async function main() {
    const input = await readHookInput();
    const state = await loadState();
    const sessionKey = hashLocalSessionId(input.session_id);
    if (eventName === "SessionStart") {
        recordSessionStart(state, sessionKey, input);
        await saveState(state);
        return;
    }
    if (eventName === "SessionEnd") {
        delete state.sessions[sessionKey];
        await saveState(state);
        return;
    }
    if (eventName === "UserPromptSubmit") {
        recordPromptStart(state, sessionKey, input);
        await saveState(state);
        return;
    }
    if (eventName === "Stop" || eventName === "StopFailure") {
        const config = await loadRemoteConfig();
        await reportCompletion({ eventName, input, state, config, sessionKey });
        await saveState(state);
    }
}
async function readHookInput() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim())
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function recordSessionStart(state, sessionKey, input) {
    const modelClass = classifyModel(input, { includeEnv: false });
    state.sessions[sessionKey] = {
        modelClass,
        updatedAtMs: Date.now()
    };
}
function recordPromptStart(state, sessionKey, input) {
    const match = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL);
    const modelClass = classifyModel(input, { includeEnv: false });
    state.pending[sessionKey] = {
        startedAtMs: Date.now(),
        targetMatched: match.matched === true,
        ...(modelClass !== "unknown" ? { modelClass } : {})
    };
}
async function reportCompletion({ eventName, input, state, config, sessionKey }) {
    const pending = state.pending[sessionKey];
    delete state.pending[sessionKey];
    if (!pending?.targetMatched || config.reportingEnabled === false)
        return;
    const currentMatch = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
    if (!currentMatch.matched)
        return;
    const targetHost = normalizeTargetHost(currentMatch.host);
    if (!targetHost)
        return;
    if (hasReachedDailyReportLimit(state))
        return;
    const ok = eventName === "Stop";
    const sampleRate = pickSampleRate(ok, config);
    if (!shouldSample(sampleRate))
        return;
    const anonymousId = await getDailyAnonymousId(state);
    const modelClass = await resolveModelClass(input, pending);
    const payload = {
        ok,
        errorType: ok ? "none" : classifyError(input),
        errorStatusCode: ok ? null : extractErrorStatusCode(input),
        errorHint: ok ? null : createErrorHint(input),
        modelClass,
        latencyBucket: bucketLatency(Date.now() - Number(pending.startedAtMs)),
        timeBucket: createTimeBucket(),
        pluginVersion: PLUGIN_VERSION,
        anonymousId,
        sampleRate,
        targetMatched: true,
        targetHost
    };
    const validation = validateReportPayload(payload);
    if (!validation.ok)
        return;
    const posted = await postReport(config.apiBaseUrl, payload);
    if (posted) {
        state.lastPayload = payload;
        state.lastReportAt = new Date().toISOString();
        incrementContribution(state);
    }
}
async function postReport(apiBaseUrl, payload) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/v1/report`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "content-type": "application/json",
                "user-agent": `anyrouter-status-monitor/${PLUGIN_VERSION}`
            },
            body: JSON.stringify(payload)
        });
        clearTimeout(timeout);
        return response.ok;
    }
    catch {
        return false;
    }
}
async function resolveModelClass(input, ...fallbacks) {
    const direct = classifyModel(input, { includeEnv: false });
    if (direct !== "unknown")
        return direct;
    const transcript = await classifyTranscriptModel(input, getTurnStartedAtMs(fallbacks));
    if (transcript !== "unknown")
        return transcript;
    for (const fallback of fallbacks) {
        if (fallback?.modelClass && fallback.modelClass !== "unknown")
            return fallback.modelClass;
    }
    return "unknown";
}
async function classifyTranscriptModel(input, turnStartedAtMs) {
    const transcriptPath = getTranscriptPath(input);
    if (!transcriptPath)
        return "unknown";
    let handle = null;
    try {
        handle = await open(transcriptPath, "r");
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0)
            return "unknown";
        const length = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, stat.size - length);
        let raw = buffer.toString("utf8");
        if (stat.size > length) {
            const firstLineEnd = raw.indexOf("\n");
            raw = firstLineEnd >= 0 ? raw.slice(firstLineEnd + 1) : "";
        }
        return classifyTranscriptText(raw, turnStartedAtMs);
    }
    catch {
        return "unknown";
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function getTranscriptPath(input) {
    const value = input.transcript_path ?? input.transcriptPath;
    if (typeof value !== "string" || value.trim() === "")
        return null;
    return value;
}
function classifyTranscriptText(raw, turnStartedAtMs) {
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line)
            continue;
        try {
            const record = JSON.parse(line);
            const timestampMs = getRecordTimestampMs(record);
            if (turnStartedAtMs !== null && timestampMs !== null && timestampMs < turnStartedAtMs)
                continue;
            const modelClass = classifyTranscriptRecord(record);
            if (modelClass !== "unknown")
                return modelClass;
        }
        catch {
            continue;
        }
    }
    return "unknown";
}
function getTurnStartedAtMs(turns) {
    for (const turn of turns) {
        if (typeof turn?.startedAtMs === "number" && Number.isFinite(turn.startedAtMs))
            return turn.startedAtMs;
    }
    return null;
}
function getRecordTimestampMs(value) {
    if (!isRecord(value))
        return null;
    const nested = isRecord(value.message) ? value.message : null;
    for (const candidate of [
        value.timestamp,
        value.created_at,
        value.createdAt,
        nested?.timestamp,
        nested?.created_at,
        nested?.createdAt
    ]) {
        const timestampMs = normalizeTimestampMs(candidate);
        if (timestampMs !== null)
            return timestampMs;
    }
    return null;
}
function normalizeTimestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value < 1_000_000_000_000 ? value * 1000 : value;
    if (typeof value !== "string" || value.trim() === "")
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function classifyTranscriptRecord(value) {
    if (!isRecord(value))
        return "unknown";
    for (const candidate of [value, value.message, value.request, value.response]) {
        if (!isRecord(candidate))
            continue;
        const modelClass = classifyModel(candidate, { includeEnv: false });
        if (modelClass !== "unknown")
            return modelClass;
    }
    return "unknown";
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
