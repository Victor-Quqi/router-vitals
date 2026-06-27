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
        const debug = await reportCompletion({ eventName: eventName, input, state, config, sessionKey });
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
        promptCount: 0,
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
    const promptCount = (sessionBefore?.promptCount ?? 0) + 1;
    state.sessions[sessionKey] = {
        ...(sessionBefore?.modelClass ? { modelClass: sessionBefore.modelClass } : {}),
        ...(modelClass !== "unknown" ? { modelClass } : {}),
        promptCount,
        updatedAtMs: Date.now()
    };
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
    const skip = (reason, details = {}) => {
        recordLastDecision(state, eventName, {
            kind: "skipped",
            reason,
            ...(pending?.modelClass ? { modelClass: pending.modelClass } : {}),
            ...details
        });
        return { ...debug, skipped: reason };
    };
    if (!pending?.targetMatched)
        return skip("pending_not_target_matched");
    if (config.reportingEnabled === false)
        return skip("reporting_disabled");
    const currentMatch = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
    if (!currentMatch.matched)
        return skip("current_target_not_matched");
    const targetHost = normalizeTargetHost(currentMatch.host);
    if (!targetHost)
        return skip("target_host_invalid");
    if (hasReachedDailyReportLimit(state))
        return skip("local_daily_limit", { targetHost });
    const ok = eventName === "Stop";
    const sampleRate = pickSampleRate(ok, config);
    if (!shouldSample(sampleRate))
        return skip("sampled_out", { targetHost });
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
            ...(state.sessions[sessionKey]?.promptCount !== undefined ? { promptCount: state.sessions[sessionKey].promptCount } : {}),
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
        return skip("payload_invalid", { modelClass, targetHost });
    const postResult = await postReport(config.apiBaseUrl, payload);
    debug.posted = postResult.ok;
    debug.postResult = summarizePostResult(postResult);
    if (postResult.ok) {
        recordLastDecision(state, eventName, {
            kind: "reported",
            reason: null,
            modelClass,
            targetHost
        });
        state.lastPayload = payload;
        state.lastReportAt = new Date().toISOString();
        incrementContribution(state);
    }
    else {
        recordLastDecision(state, eventName, {
            kind: "post_failed",
            reason: postResult.reason,
            modelClass,
            targetHost,
            ...(postResult.statusCode ? { postStatusCode: postResult.statusCode } : {})
        });
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
    let timedOut = false;
    let timeout = null;
    try {
        const controller = new AbortController();
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, 3000);
        const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/v1/report`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "content-type": "application/json",
                "user-agent": `anyrouter-status-monitor/${PLUGIN_VERSION}`
            },
            body: JSON.stringify(payload)
        });
        if (response.ok)
            return { ok: true, statusCode: response.status };
        return { ok: false, reason: "http_error", statusCode: response.status };
    }
    catch {
        return { ok: false, reason: timedOut ? "timeout" : "network_error" };
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
function recordLastDecision(state, eventName, decision) {
    state.lastDecision = {
        at: new Date().toISOString(),
        eventName,
        ...decision
    };
}
function summarizePostResult(result) {
    return {
        ok: result.ok,
        ...(result.ok ? { statusCode: result.statusCode } : { reason: result.reason }),
        ...(!result.ok && result.statusCode ? { statusCode: result.statusCode } : {})
    };
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
