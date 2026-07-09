import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadRemoteConfig } from "./config.mjs";
import { appendHookDebugRecord } from "./debug.mjs";
import { PLUGIN_VERSION, bucketAssistantStart, classifyError, classifyModel, createErrorHint, createTimeBucket, extractErrorStatusCode, hashLocalSessionId, normalizeTargetHost, pickSampleRate, shouldSample, validateReportPayload } from "./policy.mjs";
import { getDailyAnonymousId, hasReachedDailyReportLimit, incrementContribution, loadState, recordPluginUpdateReminder, shouldRemindPluginUpdate, withLockedState } from "./state.mjs";
import { getTranscriptPath, getTranscriptSize } from "./hook-transcript.mjs";
import { CodexTurnTailer, inspectCodexTurn, readCodexSessionMeta } from "./codex-transcript.mjs";
import { readCodexTurnLogErrors } from "./codex-log-errors.mjs";
import { readCodexConfigSnapshot, resolveCodexTarget } from "./codex-target.mjs";
import { postReport, recordLastDecision, summarizePostResult } from "./report.mjs";
import { MARKETPLACE_NAME, PLUGIN_FULL_ID, SITE_NAME } from "./site-config.mjs";
const CROSS_SESSION_SETTLE_MAX_PER_EVENT = 2;
const SETTLE_REPORT_MAX_LAG_MS = 15 * 60_000;
const WATCHER_FAST_WINDOW_MS = 10_000;
const WATCHER_MEDIUM_WINDOW_MS = 5 * 60_000;
const WATCHER_FAST_POLL_MS = 200;
const WATCHER_MEDIUM_POLL_MS = 1_000;
const WATCHER_SLOW_POLL_MS = 5_000;
const WATCHER_STATE_CHECK_MS = 1_000;
const WATCHER_MAX_IDLE_MS = 30 * 60_000;
const WATCHER_MAX_LIFETIME_MS = 24 * 60 * 60_000;
const WATCHER_READY_TIMEOUT_MS = 2_000;
export async function runCodexHook(eventName, input) {
    if (eventName !== "SessionStart" && eventName !== "UserPromptSubmit" && eventName !== "Stop")
        return;
    const sessionKey = hashLocalSessionId(input.session_id);
    const result = await withLockedState(async (state) => {
        let watcher = null;
        let systemMessage = null;
        await writeCodexDebug(eventName, sessionKey, "received", {
            turnId: typeof input.turn_id === "string" ? input.turn_id : null,
            model: typeof input.model === "string" ? input.model : null
        });
        // A watcher handles normal failed-turn settlement. Hooks also consume any
        // remaining pending turn so crashes and terminated watcher processes heal
        // on the next Codex lifecycle event.
        const settlement = await settlePendingTurn(eventName, input, state, sessionKey);
        if (settlement) {
            await writeCodexDebug(eventName, sessionKey, "settlement", settlement);
        }
        await settleStaleCrossSessionPendings(eventName, state, sessionKey);
        if (eventName === "SessionStart") {
            const modelClass = classifyModel({ model: input.model }, { includeEnv: false });
            state.sessions[sessionKey] = {
                ...(modelClass !== "unknown" ? { modelClass } : {}),
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
            const settlementId = randomUUID();
            state.sessions[sessionKey] = {
                ...(modelClass !== "unknown" ? { modelClass } : session?.modelClass ? { modelClass: session.modelClass } : {}),
                promptCount: (session?.promptCount ?? 0) + 1,
                updatedAtMs: Date.now()
            };
            state.pending[sessionKey] = {
                client: "codex",
                settlementId,
                startedAtMs: Date.now(),
                targetMatched: target.matched === true,
                ...(typeof input.turn_id === "string" && input.turn_id !== "" ? { turnId: input.turn_id } : {}),
                ...(transcriptPath ? { transcriptPath } : {}),
                ...(transcriptStartOffset !== null ? { transcriptStartOffset } : {}),
                ...(modelClass !== "unknown" ? { modelClass } : {})
            };
            if (target.matched && transcriptPath)
                watcher = { sessionKey, settlementId };
            await writeCodexDebug(eventName, sessionKey, "prompt_start", {
                targetMatched: target.matched,
                providerId: target.providerId,
                transcriptStartOffset,
                modelClass,
                watcherScheduled: watcher !== null
            });
        }
        if (eventName === "Stop") {
            const config = await loadRemoteConfig();
            if (shouldRemindPluginUpdate(state, config.latestPluginVersion)) {
                recordPluginUpdateReminder(state, config.latestPluginVersion);
                systemMessage = `${SITE_NAME} Status Monitor 插件有新版 ${config.latestPluginVersion}。在终端依次运行 codex plugin marketplace upgrade ${MARKETPLACE_NAME} 和 codex plugin add ${PLUGIN_FULL_ID}。更新后新会话按 hook 变化提示信任。`;
            }
        }
        return { watcher, systemMessage };
    });
    if (result.systemMessage)
        console.log(JSON.stringify({ systemMessage: result.systemMessage }));
    if (result.watcher) {
        const launch = await launchCodexWatcher(result.watcher);
        await writeCodexDebug(eventName, result.watcher.sessionKey, "watcher_launch", {
            settlementId: result.watcher.settlementId,
            ...launch
        });
    }
}
async function settlePendingTurn(eventName, input, state, sessionKey) {
    const candidate = state.pending[sessionKey];
    if (candidate?.client !== "codex")
        return null;
    const pending = candidate;
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
        return pending.client === "codex" && Boolean(pending.transcriptPath);
    })
        .sort((left, right) => left[1].startedAtMs - right[1].startedAtMs);
    let settledCount = 0;
    for (const [ownerSessionKey, pending] of candidates) {
        if (settledCount >= CROSS_SESSION_SETTLE_MAX_PER_EVENT)
            break;
        try {
            const settlement = await settleCrossSessionPendingTurn(eventName, state, ownerSessionKey, pending);
            if (!state.pending[ownerSessionKey])
                settledCount += 1;
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
    delete state.pending[ownerSessionKey];
    return settlePreparedPendingTurn({
        eventName,
        state,
        ownerSessionKey,
        pending,
        resolveTarget: (config) => resolveStoredTarget(transcriptPath, config),
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
            ...(state.sessions[ownerSessionKey] ?? { promptCount: 0, updatedAtMs: Date.now() }),
            modelClass,
            updatedAtMs: Date.now()
        };
    }
    const anonymousId = await getDailyAnonymousId(state);
    const errorEvidence = ok
        ? { messages: [], source: "none" }
        : await resolveCodexErrorEvidence(turn, pending);
    debug.errorEvidenceSource = errorEvidence.source;
    const classifiedError = errorEvidence.messages.length > 0 ? { message: errorEvidence.messages.join(" ") } : null;
    const payload = {
        ok,
        errorType: ok ? "none" : classifiedError ? classifyError(classifiedError) : "unknown",
        errorStatusCode: ok || !classifiedError ? null : extractErrorStatusCode(classifiedError),
        errorHint: ok || errorEvidence.messages.length === 0
            ? null
            : createErrorHint({ error: { message: errorEvidence.messages[0] } }),
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
async function resolveCodexErrorEvidence(turn, pending, nowMs = Date.now()) {
    if (turn.errorMessages.length > 0) {
        return { messages: turn.errorMessages, source: "rollout" };
    }
    const transcriptPath = pending.transcriptPath ?? null;
    const meta = await readCodexSessionMeta(transcriptPath);
    const messages = readCodexTurnLogErrors({
        sessionId: meta?.sessionId ?? null,
        startedAtMs: turn.taskStartedAtMs ?? pending.startedAtMs,
        endedAtMs: turn.completed || turn.aborted ? turn.lastActivityAtMs ?? nowMs : nowMs
    });
    return messages.length > 0 ? { messages, source: "logs" } : { messages: [], source: "none" };
}
export async function runCodexWatcher(sessionKey, settlementId) {
    const initialState = await loadState();
    const initialPending = getWatchedPending(initialState, sessionKey, settlementId);
    if (!initialPending?.transcriptPath)
        return;
    const startedAtMs = Date.now();
    let lastProgressAtMs = startedAtMs;
    let lastStateCheckAtMs = 0;
    const tailer = new CodexTurnTailer(initialPending.transcriptStartOffset);
    while (true) {
        const beforeOffset = tailer.currentOffset;
        const terminal = await tailer.poll(initialPending.transcriptPath, initialPending.turnId ?? null);
        const nowMs = Date.now();
        if (tailer.currentOffset !== beforeOffset)
            lastProgressAtMs = nowMs;
        if (terminal) {
            const finished = await settleWatchedPendingTurn(sessionKey, settlementId);
            if (finished)
                return;
        }
        if (nowMs - lastStateCheckAtMs >= WATCHER_STATE_CHECK_MS) {
            const state = await loadState();
            if (!getWatchedPending(state, sessionKey, settlementId))
                return;
            lastStateCheckAtMs = nowMs;
        }
        if (nowMs - lastProgressAtMs >= WATCHER_MAX_IDLE_MS || nowMs - startedAtMs >= WATCHER_MAX_LIFETIME_MS) {
            await writeCodexDebug("CodexWatcher", sessionKey, "watcher_exit", {
                settlementId,
                reason: nowMs - lastProgressAtMs >= WATCHER_MAX_IDLE_MS ? "idle_timeout" : "lifetime_timeout"
            });
            return;
        }
        await sleep(watcherPollInterval(nowMs - startedAtMs));
    }
}
async function settleWatchedPendingTurn(sessionKey, settlementId) {
    let finished = false;
    await withLockedState(async (state) => {
        const pending = getWatchedPending(state, sessionKey, settlementId);
        if (!pending) {
            finished = true;
            return;
        }
        const transcriptPath = pending.transcriptPath ?? null;
        const turn = await inspectCodexTurn(transcriptPath, pending.turnId ?? null, pending.transcriptStartOffset);
        if (!turn.completed && !turn.aborted)
            return;
        delete state.pending[sessionKey];
        const settlement = await settlePreparedPendingTurn({
            eventName: "CodexWatcher",
            state,
            ownerSessionKey: sessionKey,
            pending,
            resolveTarget: (config) => resolveStoredTarget(transcriptPath, config),
            inspectTurn: async () => turn,
            resolveModelClass: (settledTurn) => resolveCrossSessionModelClass(settledTurn, pending)
        });
        await writeCodexDebug("CodexWatcher", sessionKey, "settlement", {
            settlementId,
            ...settlement
        });
        finished = true;
    });
    return finished;
}
function getWatchedPending(state, sessionKey, settlementId) {
    const pending = state.pending[sessionKey];
    if (pending?.client !== "codex" || pending.settlementId !== settlementId)
        return null;
    return pending;
}
function watcherPollInterval(elapsedMs) {
    if (elapsedMs < WATCHER_FAST_WINDOW_MS)
        return WATCHER_FAST_POLL_MS;
    if (elapsedMs < WATCHER_MEDIUM_WINDOW_MS)
        return WATCHER_MEDIUM_POLL_MS;
    return WATCHER_SLOW_POLL_MS;
}
async function launchCodexWatcher(watcher) {
    if (process.env.ROUTER_VITALS_TEST_DISABLE_CODEX_WATCHER === "1") {
        return { ready: false, reason: "disabled" };
    }
    const workerPath = fileURLToPath(new URL("../codex-watch.mjs", import.meta.url));
    const forkOptions = {
        detached: true,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true
    };
    let child;
    try {
        child = fork(workerPath, [watcher.sessionKey, watcher.settlementId], forkOptions);
    }
    catch {
        return { ready: false, reason: "spawn_error" };
    }
    return await new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timeout);
            if (child.connected)
                child.disconnect();
            child.unref();
            resolve(result);
        };
        const timeout = setTimeout(() => finish({ ready: false, reason: "timeout" }), WATCHER_READY_TIMEOUT_MS);
        child.once("message", (message) => {
            if (isRecord(message) && message.type === "ready")
                finish({ ready: true, reason: "ready" });
        });
        child.once("error", () => finish({ ready: false, reason: "spawn_error" }));
        child.once("exit", () => finish({ ready: false, reason: "early_exit" }));
    });
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
async function resolveStoredTarget(transcriptPath, config) {
    const meta = await readCodexSessionMeta(transcriptPath);
    const configSnapshot = await readCodexConfigSnapshot();
    return resolveCodexTarget({
        sessionProviderId: meta?.modelProvider ?? null,
        config: configSnapshot,
        targetHosts: config.targetBaseUrlHosts
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
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
