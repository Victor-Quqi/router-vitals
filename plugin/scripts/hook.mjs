#!/usr/bin/env node
import { loadRemoteConfig } from "./lib/config.mjs";
import { PLUGIN_VERSION, bucketLatency, classifyError, classifyModel, createErrorHint, createTimeBucket, extractErrorStatusCode, hashLocalSessionId, matchTargetBaseUrl, pickSampleRate, shouldSample, validateReportPayload } from "./lib/policy.mjs";
import { getDailyAnonymousId, incrementContribution, loadState, saveState } from "./lib/state.mjs";
const eventName = process.argv[2] || "";
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
    state.pending[sessionKey] = {
        startedAtMs: Date.now(),
        targetMatched: match.matched === true,
        modelClass: resolveModelClass(input, state.sessions[sessionKey])
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
    const ok = eventName === "Stop";
    const sampleRate = pickSampleRate(ok, config);
    if (!shouldSample(sampleRate))
        return;
    const anonymousId = await getDailyAnonymousId(state);
    const payload = {
        ok,
        errorType: ok ? "none" : classifyError(input),
        errorStatusCode: ok ? null : extractErrorStatusCode(input),
        errorHint: ok ? null : createErrorHint(input),
        modelClass: resolveModelClass(input, pending, state.sessions[sessionKey]),
        latencyBucket: bucketLatency(Date.now() - Number(pending.startedAtMs)),
        timeBucket: createTimeBucket(),
        pluginVersion: PLUGIN_VERSION,
        anonymousId,
        sampleRate,
        targetMatched: true
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
function resolveModelClass(input, ...fallbacks) {
    const direct = classifyModel(input, { includeEnv: false });
    if (direct !== "unknown")
        return direct;
    for (const fallback of fallbacks) {
        if (fallback?.modelClass && fallback.modelClass !== "unknown")
            return fallback.modelClass;
    }
    return classifyModel(input);
}
