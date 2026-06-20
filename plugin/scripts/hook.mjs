#!/usr/bin/env node
import { loadRemoteConfig } from "./lib/config.mjs";
import { appendHookDebugRecord } from "./lib/debug.mjs";
import { PLUGIN_VERSION, bucketAssistantStart, classifyError, classifyModel, createErrorHint, createTimeBucket, extractErrorStatusCode, hashLocalSessionId, matchTargetBaseUrl, normalizeTargetHost, pickSampleRate, shouldSample, validateReportPayload } from "./lib/policy.mjs";
import { getDailyAnonymousId, hasReachedDailyReportLimit, incrementContribution, loadState, recordPluginUpdateReminder, saveState, shouldRemindPluginUpdate } from "./lib/state.mjs";
import { summarizeHookInput, summarizePayload, summarizeTurnState } from "./lib/hook-debug-summary.mjs";
import { getTranscriptSize, inspectTranscript } from "./lib/hook-transcript.mjs";
import { resolveModelClass, resolvePromptStartModelClass } from "./lib/hook-model-resolution.mjs";
const eventName = process.argv[2] || "";
main().catch(() => {
    process.exit(0);
});
async function main() {
    const input = await readHookInput();
    const state = await loadState();
    const sessionKey = hashLocalSessionId(input.session_id);
    await writeHookDebug(sessionKey, "received", {
        input: summarizeHookInput(input),
        sessionBefore: summarizeTurnState(state.sessions[sessionKey]),
        pendingBefore: summarizeTurnState(state.pending[sessionKey])
    });
    if (eventName === "SessionStart") {
        const modelClass = recordSessionStart(state, sessionKey, input);
        await writeHookDebug(sessionKey, "session_start", {
            modelClass,
            sessionAfter: summarizeTurnState(state.sessions[sessionKey])
        });
        await saveState(state);
        return;
    }
    if (eventName === "SessionEnd") {
        delete state.sessions[sessionKey];
        await writeHookDebug(sessionKey, "session_end", {
            sessionAfter: summarizeTurnState(state.sessions[sessionKey])
        });
        await saveState(state);
        return;
    }
    if (eventName === "UserPromptSubmit") {
        const debug = await recordPromptStart(state, sessionKey, input);
        await writeHookDebug(sessionKey, "prompt_start", debug);
        await saveState(state);
        return;
    }
    if (eventName === "Stop" || eventName === "StopFailure") {
        const config = await loadRemoteConfig();
        const updateReminderMessage = createPluginUpdateReminderMessage(state, config);
        const debug = await reportCompletion({ eventName, input, state, config, sessionKey });
        if (updateReminderMessage) {
            debug.updateReminder = {
                latestPluginVersion: config.latestPluginVersion,
                emitted: true
            };
        }
        await writeHookDebug(sessionKey, "completion", debug);
        await saveState(state);
        if (updateReminderMessage)
            writeHookSystemMessage(updateReminderMessage);
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
    return modelClass;
}
async function recordPromptStart(state, sessionKey, input) {
    const match = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL);
    const transcriptStartOffset = await getTranscriptSize(input);
    const sessionBefore = state.sessions[sessionKey];
    const resolution = await resolvePromptStartModelClass(input, sessionBefore, transcriptStartOffset);
    const modelClass = resolution.modelClass;
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
    return {
        targetMatched: match.matched === true,
        transcriptStartOffset,
        sessionBefore: summarizeTurnState(sessionBefore),
        promptModelClass: modelClass,
        promptSource: resolution.source,
        directInputModelClass: resolution.directInputModelClass,
        promptTranscript: resolution.transcript,
        pendingAfter: summarizeTurnState(state.pending[sessionKey]),
        sessionAfter: summarizeTurnState(state.sessions[sessionKey])
    };
}
async function reportCompletion({ eventName, input, state, config, sessionKey }) {
    const pending = state.pending[sessionKey];
    delete state.pending[sessionKey];
    const debug = {
        pending: summarizeTurnState(pending),
        skipped: null
    };
    if (!pending?.targetMatched)
        return { ...debug, skipped: "pending_not_target_matched" };
    if (config.reportingEnabled === false)
        return { ...debug, skipped: "reporting_disabled" };
    const currentMatch = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
    if (!currentMatch.matched)
        return { ...debug, skipped: "current_target_not_matched" };
    const targetHost = normalizeTargetHost(currentMatch.host);
    if (!targetHost)
        return { ...debug, skipped: "target_host_invalid" };
    if (hasReachedDailyReportLimit(state))
        return { ...debug, skipped: "local_daily_limit" };
    const ok = eventName === "Stop";
    const sampleRate = pickSampleRate(ok, config);
    if (!shouldSample(sampleRate))
        return { ...debug, skipped: "sampled_out" };
    const anonymousId = await getDailyAnonymousId(state);
    const turnStartedAtMs = getTurnStartedAtMs([pending]);
    const transcript = await inspectTranscript(input, turnStartedAtMs, pending.transcriptStartOffset);
    const modelResolution = resolveModelClass(input, transcript, pending);
    const modelClass = modelResolution.modelClass;
    debug.transcript = transcript;
    debug.modelResolution = modelResolution;
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
    debug.payload = summarizePayload(payload, validation.ok);
    if (!validation.ok)
        return { ...debug, skipped: "payload_invalid" };
    const posted = await postReport(config.apiBaseUrl, payload);
    debug.posted = posted;
    if (posted) {
        state.lastPayload = payload;
        state.lastReportAt = new Date().toISOString();
        incrementContribution(state);
    }
    return debug;
}
function createPluginUpdateReminderMessage(state, config) {
    if (!shouldRemindPluginUpdate(state, config.latestPluginVersion))
        return null;
    recordPluginUpdateReminder(state, config.latestPluginVersion);
    return `Any Router Status Monitor 插件有新版 ${config.latestPluginVersion}。运行 /plugin update anyrouter-status-monitor@router-vitals，更新后执行 /reload-plugins。`;
}
function writeHookSystemMessage(systemMessage) {
    console.log(JSON.stringify({ systemMessage }));
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
function getTurnStartedAtMs(turns) {
    for (const turn of turns) {
        if (typeof turn?.startedAtMs === "number" && Number.isFinite(turn.startedAtMs))
            return turn.startedAtMs;
    }
    return null;
}
async function writeHookDebug(sessionKey, stage, data) {
    await appendHookDebugRecord({
        at: new Date().toISOString(),
        eventName,
        sessionKey,
        stage,
        data
    });
}
