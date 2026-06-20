#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { loadRemoteConfig } from "./lib/config.mjs";
import { PLUGIN_VERSION, bucketAssistantStart, classifyError, classifyModel, createErrorHint, createTimeBucket, extractErrorStatusCode, hashLocalSessionId, matchTargetBaseUrl, normalizeTargetHost, pickSampleRate, shouldSample, validateReportPayload } from "./lib/policy.mjs";
import { getDailyAnonymousId, hasReachedDailyReportLimit, incrementContribution, loadState, saveState } from "./lib/state.mjs";
const eventName = process.argv[2] || "";
const TRANSCRIPT_MODEL_LOOKBACK_BYTES = 256 * 1024;
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
        await recordPromptStart(state, sessionKey, input);
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
    const modelClass = classifyModel(input);
    state.sessions[sessionKey] = {
        modelClass,
        updatedAtMs: Date.now()
    };
}
async function recordPromptStart(state, sessionKey, input) {
    const match = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL);
    const transcriptStartOffset = await getTranscriptSize(input);
    const modelClass = await resolvePromptStartModelClass(input, state.sessions[sessionKey], transcriptStartOffset);
    if (modelClass !== "unknown") {
        state.sessions[sessionKey] = {
            modelClass,
            updatedAtMs: Date.now()
        };
    }
    state.pending[sessionKey] = {
        startedAtMs: Date.now(),
        targetMatched: match.matched === true,
        ...(transcriptStartOffset !== null ? { transcriptStartOffset } : {}),
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
    const turnStartedAtMs = getTurnStartedAtMs([pending]);
    const transcript = await inspectTranscript(input, turnStartedAtMs, pending.transcriptStartOffset);
    const modelClass = resolveModelClass(input, transcript, pending);
    if (modelClass !== "unknown") {
        state.sessions[sessionKey] = {
            modelClass,
            updatedAtMs: Date.now()
        };
    }
    const assistantStartDelayMs = turnStartedAtMs !== null && transcript.firstAssistantAtMs !== null
        ? transcript.firstAssistantAtMs - turnStartedAtMs
        : null;
    const payload = {
        ok,
        errorType: ok ? "none" : classifyError(input),
        errorStatusCode: ok ? null : extractErrorStatusCode(input),
        errorHint: ok ? null : createErrorHint(input),
        modelClass,
        assistantStartBucket: bucketAssistantStart(assistantStartDelayMs),
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
function resolveModelClass(input, transcript, ...fallbacks) {
    const direct = classifyModel(input, { includeEnv: false });
    if (direct !== "unknown")
        return direct;
    if (transcript.modelClass !== "unknown")
        return transcript.modelClass;
    for (const fallback of fallbacks) {
        if (fallback?.modelClass && fallback.modelClass !== "unknown")
            return fallback.modelClass;
    }
    return "unknown";
}
async function resolvePromptStartModelClass(input, session, transcriptStartOffset) {
    const direct = classifyModel(input, { includeEnv: false });
    if (direct !== "unknown")
        return direct;
    const transcript = await inspectPromptStartTranscript(input, transcriptStartOffset);
    if (!transcript.inspected)
        return "unknown";
    if (transcript.modelClass !== "unknown")
        return transcript.modelClass;
    return session?.modelClass && session.modelClass !== "unknown" ? session.modelClass : "unknown";
}
async function inspectPromptStartTranscript(input, transcriptStartOffset) {
    const transcriptPath = getTranscriptPath(input);
    const result = {
        inspected: false,
        modelClass: "unknown"
    };
    if (!transcriptPath || transcriptStartOffset === null)
        return result;
    result.inspected = true;
    if (transcriptStartOffset <= 0)
        return result;
    try {
        const start = Math.max(0, transcriptStartOffset - TRANSCRIPT_MODEL_LOOKBACK_BYTES);
        const stream = createReadStream(transcriptPath, {
            encoding: "utf8",
            start,
            end: transcriptStartOffset - 1
        });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        let skipFirstLine = start > 0;
        for await (const line of lines) {
            if (skipFirstLine) {
                skipFirstLine = false;
                continue;
            }
            const raw = line.trim();
            if (!raw)
                continue;
            try {
                const record = JSON.parse(raw);
                const modelClass = classifyModelSetOutput(record) || classifyTranscriptRecord(record);
                if (modelClass !== "unknown") {
                    result.modelClass = modelClass;
                }
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return {
            inspected: false,
            modelClass: "unknown"
        };
    }
    return result;
}
async function inspectTranscript(input, turnStartedAtMs, transcriptStartOffset) {
    const transcriptPath = getTranscriptPath(input);
    const result = {
        firstAssistantAtMs: null,
        modelClass: "unknown"
    };
    if (!transcriptPath)
        return result;
    try {
        const start = Number.isFinite(transcriptStartOffset) && Number(transcriptStartOffset) > 0
            ? Number(transcriptStartOffset)
            : 0;
        const stream = createReadStream(transcriptPath, { encoding: "utf8", start });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
            const raw = line.trim();
            if (!raw)
                continue;
            try {
                const record = JSON.parse(raw);
                const timestampMs = getRecordTimestampMs(record);
                if (turnStartedAtMs !== null && timestampMs !== null && timestampMs < turnStartedAtMs)
                    continue;
                if (result.firstAssistantAtMs === null && isAssistantRecord(record) && timestampMs !== null) {
                    result.firstAssistantAtMs = timestampMs;
                }
                const modelClass = classifyTranscriptRecord(record);
                if (modelClass !== "unknown")
                    result.modelClass = modelClass;
            }
            catch {
                continue;
            }
        }
        return result;
    }
    catch {
        return result;
    }
}
function getTranscriptPath(input) {
    const value = input.transcript_path ?? input.transcriptPath;
    if (typeof value !== "string" || value.trim() === "")
        return null;
    return value;
}
function getTurnStartedAtMs(turns) {
    for (const turn of turns) {
        if (typeof turn?.startedAtMs === "number" && Number.isFinite(turn.startedAtMs))
            return turn.startedAtMs;
    }
    return null;
}
async function getTranscriptSize(input) {
    const transcriptPath = getTranscriptPath(input);
    if (!transcriptPath)
        return null;
    try {
        const info = await stat(transcriptPath);
        return info.isFile() ? info.size : null;
    }
    catch {
        return null;
    }
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
function classifyModelSetOutput(value) {
    if (!isRecord(value))
        return null;
    const message = isRecord(value.message) ? value.message : null;
    const text = getStringContent(value.content) ?? getStringContent(message?.content);
    if (!text)
        return null;
    const lower = text.toLowerCase();
    const isLocalCommand = value.subtype === "local_command"
        || message?.subtype === "local_command"
        || lower.includes("<local-command-stdout>");
    if (!isLocalCommand)
        return null;
    const match = text.match(/(?:^|[>\r\n])\s*set\s+model\s+to\s+(opus|sonnet|haiku)\b/i);
    if (!match)
        return null;
    const model = match[1].toLowerCase();
    if (model === "opus" || model === "sonnet" || model === "haiku")
        return model;
    return null;
}
function getStringContent(value) {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}
function isAssistantRecord(value) {
    if (!isRecord(value))
        return false;
    if (value.type === "assistant" || value.role === "assistant")
        return true;
    const message = isRecord(value.message) ? value.message : null;
    return message?.type === "assistant" || message?.role === "assistant";
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
