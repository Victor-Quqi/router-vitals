import { loadRemoteConfig } from "./config.mjs";
import { appendHookDebugRecord } from "./debug.mjs";
import { PLUGIN_VERSION, bucketAssistantStart, classifyError, classifyModel, createErrorHint, createTimeBucket, extractErrorStatusCode, hashLocalSessionId, normalizeTargetHost, pickSampleRate, shouldSample, validateReportPayload } from "./policy.mjs";
import { getDailyAnonymousId, hasReachedDailyReportLimit, incrementContribution, loadState, recordPluginUpdateReminder, saveState, shouldRemindPluginUpdate } from "./state.mjs";
import { getTranscriptPath, getTranscriptSize } from "./hook-transcript.mjs";
import { inspectCodexTurn, readCodexSessionMeta } from "./codex-transcript.mjs";
import { readCodexConfigSnapshot, resolveCodexTarget } from "./codex-target.mjs";
import { postReport, recordLastDecision, summarizePostResult } from "./report.mjs";
import { MARKETPLACE_NAME, PLUGIN_FULL_ID, SITE_NAME } from "./site-config.mjs";
const CROSS_SESSION_SETTLE_MAX_PER_EVENT = 2;
const SETTLE_OWNER_GRACE_MS = 60_000;
const SETTLE_REPORT_MAX_LAG_MS = 15 * 60_000;
export async function runCodexHook(eventName, input) {
    if (eventName !== "SessionStart" && eventName !== "UserPromptSubmit" && eventName !== "Stop")
        return;
    const state = await loadState();
    const sessionKey = hashLocalSessionId(input.session_id);
    await writeCodexDebug(eventName, sessionKey, "received", {
        turnId: typeof input.turn_id === "string" ? input.turn_id : null,
        model: typeof input.model === "string" ? input.model : null
    });
    // Failed Codex turns end without a Stop hook, so every event first settles
    // whatever turn is still pending for this session before recording its own.
    const settlement = await settlePendingTurn(eventName, input, state, sessionKey);
    if (settlement)
        await writeCodexDebug(eventName, sessionKey, "settlement", settlement);
    await settleStaleCrossSessionPendings(eventName, state, sessionKey);
    if (eventName === "SessionStart") {
        state.sessions[sessionKey] = {
            modelClass: classifyModel({ model: input.model }, { includeEnv: false }),
            promptCount: 0,
            updatedAtMs: Date.now()
        };
    }
    if (eventName === "UserPromptSubmit") {
        const target = await resolveCurrentTarget(input);
        const transcriptPath = getTranscriptPath(input);
        const transcriptStartOffset = await getTranscriptSize(input);
        const modelClass = classifyModel({ model: input.model }, { includeEnv: false });
        const session = state.sessions[sessionKey];
        state.sessions[sessionKey] = {
            ...(modelClass !== "unknown" ? { modelClass } : session?.modelClass ? { modelClass: session.modelClass } : {}),
            promptCount: (session?.promptCount ?? 0) + 1,
            updatedAtMs: Date.now()
        };
        state.pending[sessionKey] = {
            startedAtMs: Date.now(),
            targetMatched: target.matched === true,
            ...(typeof input.turn_id === "string" && input.turn_id !== "" ? { turnId: input.turn_id } : {}),
            ...(transcriptPath ? { transcriptPath } : {}),
            ...(transcriptStartOffset !== null ? { transcriptStartOffset } : {}),
            ...(modelClass !== "unknown" ? { modelClass } : {})
        };
        await writeCodexDebug(eventName, sessionKey, "prompt_start", {
            targetMatched: target.matched,
            providerId: target.providerId,
            transcriptStartOffset,
            modelClass
        });
    }
    // Codex has no statusLine surface, so update reminders ride the Stop hook's
    // systemMessage output at the same low frequency as the Claude Code path.
    // Both commands are required in order: `upgrade` refreshes the marketplace
    // snapshot, `add` installs from it into the versioned cache plugins run
    // from (verified against a git marketplace). No `&&`: PowerShell 5.1
    // doesn't support it.
    if (eventName === "Stop") {
        const config = await loadRemoteConfig();
        if (shouldRemindPluginUpdate(state, config.latestPluginVersion)) {
            recordPluginUpdateReminder(state, config.latestPluginVersion);
            console.log(JSON.stringify({
                systemMessage: `${SITE_NAME} Status Monitor 插件有新版 ${config.latestPluginVersion}。在终端依次运行 codex plugin marketplace upgrade ${MARKETPLACE_NAME} 和 codex plugin add ${PLUGIN_FULL_ID}。更新后新会话按 hook 变化提示信任。`
            }));
        }
    }
    await saveState(state);
}
async function settlePendingTurn(eventName, input, state, sessionKey) {
    const pending = state.pending[sessionKey];
    if (!pending)
        return null;
    delete state.pending[sessionKey];
    return settlePreparedPendingTurn({
        eventName,
        state,
        ownerSessionKey: sessionKey,
        pending,
        resolveTarget: (config) => resolveCurrentTarget(input, config),
        inspectTurn: () => inspectCodexTurnSettled(eventName, input, pending),
        resolveModelClass: (turn) => resolveCodexModelClass(turn, input, pending)
    });
}
async function settleStaleCrossSessionPendings(eventName, state, currentSessionKey) {
    const candidates = Object.entries(state.pending)
        .filter(([ownerSessionKey, pending]) => {
        if (ownerSessionKey === currentSessionKey)
            return false;
        return Boolean(pending.transcriptPath);
    })
        .sort((left, right) => (left[1].startedAtMs ?? 0) - (right[1].startedAtMs ?? 0))
        .slice(0, CROSS_SESSION_SETTLE_MAX_PER_EVENT);
    for (const [ownerSessionKey, pending] of candidates) {
        try {
            const settlement = await settleCrossSessionPendingTurn(eventName, state, ownerSessionKey, pending);
            await writeCodexDebug(eventName, currentSessionKey, "cross_settlement", {
                ownerSessionKey,
                ...settlement
            });
        }
        catch (error) {
            await writeCodexDebug(eventName, currentSessionKey, "cross_settlement", {
                ownerSessionKey,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
}
async function settleCrossSessionPendingTurn(eventName, state, ownerSessionKey, pending) {
    const transcriptPath = pending.transcriptPath ?? null;
    const turn = await inspectCodexTurn(transcriptPath, pending.turnId ?? null, pending.transcriptStartOffset);
    if (!turn.found)
        return { hadPending: true, skipped: "turn_evidence_missing", turn };
    if (!turn.completed && !turn.aborted)
        return { hadPending: true, skipped: null, turn };
    if (turn.lastActivityAtMs !== null && Date.now() - turn.lastActivityAtMs < SETTLE_OWNER_GRACE_MS) {
        return { hadPending: true, skipped: null, turn };
    }
    delete state.pending[ownerSessionKey];
    return settlePreparedPendingTurn({
        eventName,
        state,
        ownerSessionKey,
        pending,
        resolveTarget: async (config) => {
            const meta = await readCodexSessionMeta(transcriptPath);
            const configSnapshot = await readCodexConfigSnapshot();
            return resolveCodexTarget({
                sessionProviderId: meta?.modelProvider ?? null,
                config: configSnapshot,
                targetHosts: config.targetBaseUrlHosts
            });
        },
        inspectTurn: async () => turn,
        resolveModelClass: (settledTurn) => resolveCrossSessionModelClass(settledTurn, pending)
    });
}
async function settlePreparedPendingTurn({ eventName, state, ownerSessionKey, pending, resolveTarget, inspectTurn, resolveModelClass }) {
    const debug = { hadPending: true, skipped: null };
    const skip = (reason, extra = {}) => {
        recordLastDecision(state, eventName, {
            kind: "skipped",
            reason,
            ...(extra.modelClass || pending.modelClass ? { modelClass: extra.modelClass ?? pending.modelClass } : {}),
            ...(extra.targetHost ? { targetHost: extra.targetHost } : {})
        });
        return { ...debug, skipped: reason };
    };
    if (!pending.targetMatched)
        return skip("pending_not_target_matched");
    const config = await loadRemoteConfig();
    if (config.reportingEnabled === false)
        return skip("reporting_disabled");
    const target = await resolveTarget(config);
    debug.target = target;
    if (!target.matched)
        return skip("current_target_not_matched");
    const targetHost = normalizeTargetHost(target.host);
    if (!targetHost)
        return skip("target_host_invalid");
    if (hasReachedDailyReportLimit(state))
        return skip("local_daily_limit", { targetHost });
    const turn = await inspectTurn();
    debug.turn = turn;
    if (!turn.found)
        return skip("turn_evidence_missing", { targetHost });
    if (turn.aborted)
        return skip("turn_aborted", { targetHost });
    // Missing timestamps keep the previous settlement behavior for malformed rollout rows.
    if (turn.lastActivityAtMs !== null && Date.now() - turn.lastActivityAtMs > SETTLE_REPORT_MAX_LAG_MS) {
        return skip("pending_expired", { targetHost });
    }
    const ok = turn.hasModelOutput;
    const sampleRate = pickSampleRate(ok, config);
    if (!shouldSample(sampleRate))
        return skip("sampled_out", { targetHost });
    const modelClass = resolveModelClass(turn);
    if (modelClass !== "unknown") {
        state.sessions[ownerSessionKey] = {
            ...state.sessions[ownerSessionKey],
            modelClass,
            updatedAtMs: Date.now()
        };
    }
    const anonymousId = await getDailyAnonymousId(state);
    const errorEvidence = turn.errorMessages.length > 0 ? { message: turn.errorMessages.join(" ") } : null;
    const payload = {
        ok,
        errorType: ok ? "none" : errorEvidence ? classifyError(errorEvidence) : "unknown",
        errorStatusCode: ok || !errorEvidence ? null : extractErrorStatusCode(errorEvidence),
        errorHint: ok || turn.errorMessages.length === 0 ? null : createErrorHint({ error: { message: turn.errorMessages[0] } }),
        client: "codex",
        modelClass,
        assistantStartBucket: bucketAssistantStart(ok ? resolveAssistantStartDelayMs(turn, pending) : null),
        timeBucket: createTimeBucket(),
        pluginVersion: PLUGIN_VERSION,
        anonymousId,
        sampleRate,
        targetMatched: true,
        targetHost
    };
    const validation = validateReportPayload(payload);
    debug.payload = { ...payload, anonymousId: "[anon]", valid: validation.ok };
    if (!validation.ok)
        return skip("payload_invalid", { modelClass, targetHost });
    const postResult = await postReport(config.apiBaseUrl, payload);
    debug.posted = postResult.ok;
    debug.postResult = summarizePostResult(postResult);
    if (postResult.ok) {
        recordLastDecision(state, eventName, { kind: "reported", reason: null, modelClass, targetHost });
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
async function resolveCurrentTarget(input, config) {
    const meta = await readCodexSessionMeta(getTranscriptPath(input));
    const configSnapshot = await readCodexConfigSnapshot();
    return resolveCodexTarget({
        sessionProviderId: meta?.modelProvider ?? null,
        config: configSnapshot,
        ...(config ? { targetHosts: config.targetBaseUrlHosts } : {})
    });
}
// The Stop hook races the rollout writer: in TUI sessions task_complete can
// flush shortly after the hook fires, so one short re-read recovers completion
// metadata (TTFT). In exec sessions the writer waits for the hook to exit, so
// retrying only adds latency; the timestamp fallback covers those turns.
async function inspectCodexTurnSettled(eventName, input, pending) {
    const transcriptPath = getTranscriptPath(input);
    const turn = await inspectCodexTurn(transcriptPath, pending.turnId ?? null, pending.transcriptStartOffset);
    if (eventName !== "Stop" || !turn.found || turn.completed || turn.aborted)
        return turn;
    const meta = await readCodexSessionMeta(transcriptPath);
    if (meta?.originator && meta.originator.includes("exec"))
        return turn;
    await sleep(250);
    return inspectCodexTurn(transcriptPath, pending.turnId ?? null, pending.transcriptStartOffset);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveCodexModelClass(turn, input, pending) {
    const fromTurn = classifyModel({ model: turn.model }, { includeEnv: false });
    if (fromTurn !== "unknown")
        return fromTurn;
    const fromInput = classifyModel({ model: input.model }, { includeEnv: false });
    if (fromInput !== "unknown")
        return fromInput;
    return pending.modelClass ?? "unknown";
}
function resolveCrossSessionModelClass(turn, pending) {
    const fromTurn = classifyModel({ model: turn.model }, { includeEnv: false });
    if (fromTurn !== "unknown")
        return fromTurn;
    return pending.modelClass ?? "unknown";
}
// Prefer the client-measured TTFT from task_complete; fall back to rollout
// timestamps (same writer clock), then to the hook wall clock.
function resolveAssistantStartDelayMs(turn, pending) {
    if (turn.timeToFirstTokenMs !== null)
        return turn.timeToFirstTokenMs;
    const startRef = turn.taskStartedAtMs ?? pending.startedAtMs ?? null;
    if (turn.firstOutputAtMs !== null && startRef !== null)
        return turn.firstOutputAtMs - startRef;
    return null;
}
async function writeCodexDebug(eventName, sessionKey, stage, data) {
    await appendHookDebugRecord({
        at: new Date().toISOString(),
        eventName,
        sessionKey,
        stage: `codex_${stage}`,
        data: { client: "codex", ...data }
    });
}
