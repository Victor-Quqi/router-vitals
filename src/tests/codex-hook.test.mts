import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TARGET_HOSTS, classifyModel, hashLocalSessionId } from "../plugin/scripts/lib/policy.mjs";
import { parseCodexConfigSnapshot, resolveCodexTarget } from "../plugin/scripts/lib/codex-target.mjs";
import { CodexTurnTailer, inspectCodexTurn, readCodexSessionMeta } from "../plugin/scripts/lib/codex-transcript.mjs";
import { MARKETPLACE_NAME, PLUGIN_FULL_ID, PLUGIN_ID } from "../shared/site-config.mjs";

const hookPath = resolve("plugin/scripts/hook.mjs");
const primaryTargetHost = TARGET_HOSTS[0]!;
const secondaryTargetHost = TARGET_HOSTS[1]!;
const providerId = "target_provider";
const targetBaseUrl = `https://${primaryTargetHost}/v1`;
const targetResponsesUrl = `${targetBaseUrl}/responses`;

test("classifies gpt-5.5 model ids into the gpt-5.5 class", () => {
  assert.equal(classifyModel({ model: "gpt-5.5" }, { includeEnv: false }), "gpt-5.5");
  assert.equal(classifyModel({ model: "gpt-5.5-codex" }, { includeEnv: false }), "gpt-5.5");
  assert.equal(classifyModel({ model: "gpt-4.1" }, { includeEnv: false }), "unknown");
});

test("codex config snapshot extracts providers without touching secrets", () => {
  const snapshot = parseCodexConfigSnapshot([
    'model = "gpt-5.5"',
    `model_provider = "${providerId}"`,
    "",
    `[model_providers.${providerId}]`,
    'name = "Target Provider"',
    'env_key = "SHOULD_NEVER_BE_READ"',
    `base_url = "${targetBaseUrl}"`,
    "",
    "[model_providers.other]",
    'base_url = "https://api.other.example/v1"',
    "",
    "[profiles.backup]",
    'model_provider = "other"'
  ].join("\n"));

  assert.equal(snapshot.providerBaseUrls[providerId], targetBaseUrl);
  assert.equal(snapshot.providerBaseUrls.other, "https://api.other.example/v1");
  assert.equal(JSON.stringify(snapshot).includes("SHOULD_NEVER_BE_READ"), false);
});

test("codex target resolution requires the rollout session provider", () => {
  const config = parseCodexConfigSnapshot([
    'profile = "backup"',
    `model_provider = "${providerId}"`,
    `[model_providers.${providerId}]`,
    `base_url = "${targetBaseUrl}"`,
    "[model_providers.other]",
    'base_url = "https://api.other.example/v1"',
    "[profiles.backup]",
    'model_provider = "other"'
  ].join("\n"));

  const fromSession = resolveCodexTarget({ sessionProviderId: providerId, config });
  assert.equal(fromSession.matched, true);
  assert.equal(fromSession.host, primaryTargetHost);

  const withoutSessionProvider = resolveCodexTarget({ sessionProviderId: null, config });
  assert.equal(withoutSessionProvider.providerId, null);
  assert.equal(withoutSessionProvider.matched, false);

  const unknownProvider = resolveCodexTarget({ sessionProviderId: "missing", config });
  assert.equal(unknownProvider.matched, false);
  assert.equal(unknownProvider.baseUrl, null);

  const openaiProvider = resolveCodexTarget({
    sessionProviderId: "openai",
    config: parseCodexConfigSnapshot([
      "[model_providers.openai]",
      `base_url = "${targetBaseUrl}"`
    ].join("\n"))
  });
  assert.equal(openaiProvider.matched, true);
});

test("codex turn inspection reads success, failure, and abort evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-rollout-"));
  const path = join(dir, "rollout-test.jsonl");
  const baseMs = Date.parse("2026-07-02T08:00:00.000Z");
  await writeFile(path, [
    rolloutLine(baseMs - 60000, "session_meta", { session_id: "s1", model_provider: providerId, cli_version: "0.142.5" }),
    rolloutLine(baseMs, "event_msg", { type: "task_started", turn_id: "t-ok" }),
    rolloutLine(baseMs, "turn_context", { turn_id: "t-ok", model: "gpt-5.5" }),
    rolloutLine(baseMs + 100, "event_msg", { type: "user_message", message: "hi" }),
    rolloutLine(baseMs + 4000, "response_item", { type: "reasoning", id: "rs_1" }),
    rolloutLine(baseMs + 6000, "event_msg", { type: "agent_message", message: "ok" }),
    rolloutLine(baseMs + 6100, "event_msg", { type: "task_complete", turn_id: "t-ok", duration_ms: 6100, time_to_first_token_ms: 3500 }),
    rolloutLine(baseMs + 10000, "event_msg", { type: "task_started", turn_id: "t-fail" }),
    rolloutLine(baseMs + 10000, "turn_context", { turn_id: "t-fail", model: "gpt-5.5" }),
    rolloutLine(baseMs + 10100, "event_msg", { type: "user_message", message: "again" }),
    rolloutLine(baseMs + 15000, "event_msg", { type: "error", message: `unexpected status 503 Service Unavailable: no channel, url: ${targetResponsesUrl}`, codex_error_info: "other" }),
    rolloutLine(baseMs + 15001, "event_msg", { type: "task_complete", turn_id: "t-fail", duration_ms: 5001 }),
    rolloutLine(baseMs + 20000, "event_msg", { type: "task_started", turn_id: "t-abort" }),
    rolloutLine(baseMs + 21000, "event_msg", { type: "turn_aborted", turn_id: "t-abort", reason: "interrupted" })
  ].join("\n") + "\n", "utf8");

  const meta = await readCodexSessionMeta(path);
  assert.equal(meta?.modelProvider, providerId);

  const okTurn = await inspectCodexTurn(path, "t-ok", 0);
  assert.equal(okTurn.found, true);
  assert.equal(okTurn.hasModelOutput, true);
  assert.equal(okTurn.completed, true);
  assert.equal(okTurn.timeToFirstTokenMs, 3500);
  assert.equal(okTurn.model, "gpt-5.5");
  assert.equal(okTurn.aborted, false);
  assert.equal(okTurn.lastActivityAtMs, baseMs + 6100);

  const failTurn = await inspectCodexTurn(path, "t-fail", 0);
  assert.equal(failTurn.found, true);
  assert.equal(failTurn.hasModelOutput, false);
  assert.equal(failTurn.completed, true);
  assert.equal(failTurn.timeToFirstTokenMs, null);
  assert.equal(failTurn.errorMessages.length, 1);
  assert.equal(failTurn.lastActivityAtMs, baseMs + 15001);

  const abortTurn = await inspectCodexTurn(path, "t-abort", 0);
  assert.equal(abortTurn.found, true);
  assert.equal(abortTurn.aborted, true);
  assert.equal(abortTurn.abortReason, "interrupted");
  assert.equal(abortTurn.lastActivityAtMs, baseMs + 21000);
});

test("codex turn inspection rewinds past offsets taken after the turn markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-rollout-rewind-"));
  const path = join(dir, "rollout-rewind.jsonl");
  const baseMs = Date.parse("2026-07-02T08:00:00.000Z");
  const lines = [
    rolloutLine(baseMs - 60000, "session_meta", { session_id: "s1", model_provider: providerId }),
    rolloutLine(baseMs, "event_msg", { type: "task_started", turn_id: "t-late" }),
    rolloutLine(baseMs, "turn_context", { turn_id: "t-late", model: "gpt-5.5" }),
    rolloutLine(baseMs + 100, "event_msg", { type: "user_message", message: "hi" }),
    rolloutLine(baseMs + 4000, "response_item", { type: "reasoning", id: "rs_1" }),
    rolloutLine(baseMs + 6100, "event_msg", { type: "task_complete", turn_id: "t-late", duration_ms: 6100, time_to_first_token_ms: 3500 })
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf8");

  // Offset as captured by the prompt hook: after task_started/turn_context.
  const lateOffset = Buffer.byteLength(lines.slice(0, 4).join("\n") + "\n", "utf8");
  const turn = await inspectCodexTurn(path, "t-late", lateOffset);
  assert.equal(turn.found, true);
  assert.equal(turn.model, "gpt-5.5");
  assert.equal(turn.hasModelOutput, true);
  assert.equal(turn.completed, true);
  assert.equal(turn.timeToFirstTokenMs, 3500);
  assert.notEqual(turn.taskStartedAtMs, null);
  assert.equal(turn.lastActivityAtMs, baseMs + 6100);
});

test("codex turn tailer reads only appended terminal records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-rollout-tail-"));
  const path = join(dir, "rollout-tail.jsonl");
  const baseMs = Date.now();
  await writeFile(path, [
    rolloutLine(baseMs, "session_meta", { session_id: "s-tail", model_provider: providerId }),
    rolloutLine(baseMs + 1, "event_msg", { type: "task_started", turn_id: "t-tail" }),
    rolloutLine(baseMs + 2, "turn_context", { turn_id: "t-tail", model: "gpt-5.5" })
  ].join("\n") + "\n", "utf8");
  const startOffset = Buffer.byteLength(await readFile(path, "utf8"), "utf8");
  const tailer = new CodexTurnTailer(startOffset);

  assert.equal(await tailer.poll(path, "t-tail"), null);
  await appendRollout(path, [
    rolloutLine(baseMs + 3, "event_msg", { type: "error", message: "请求失败" }),
    rolloutLine(baseMs + 4, "event_msg", { type: "task_complete", turn_id: "t-tail", duration_ms: 3 })
  ]);
  assert.equal(await tailer.poll(path, "t-tail"), "completed");
  assert.equal(tailer.currentOffset, Buffer.byteLength(await readFile(path, "utf8"), "utf8"));
});

test("codex hook reports settled turns only for matched providers", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: `http://127.0.0.1:${serverPort(server)}`,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["60m"]
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/report") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        respondJson(res, { ok: true });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
  await writeFile(join(codexHome, "config.toml"), [
    'model = "gpt-5.5"',
    `model_provider = "${providerId}"`,
    `[model_providers.${providerId}]`,
    `base_url = "${targetBaseUrl}"`
  ].join("\n") + "\n", "utf8");

  const transcript = join(stateDir, "rollout-codex.jsonl");
  const env = {
    ...process.env,
    ROUTER_VITALS_STATE_DIR: stateDir,
    ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
    CODEX_HOME: codexHome
  };
  const baseMs = Date.now() - 3 * 60 * 1000;
  const baseInput = { session_id: "codex-session", transcript_path: transcript, cwd: stateDir, model: "gpt-5.5" };

  try {
    await writeFile(transcript, rolloutLine(baseMs, "session_meta", {
      session_id: "codex-session",
      model_provider: providerId,
      cli_version: "0.142.5"
    }) + "\n", "utf8");

    await runCodexHook("SessionStart", { ...baseInput, source: "startup" }, env);

    // Turn 1: succeeds; settled by its Stop hook.
    await runCodexHook("UserPromptSubmit", { ...baseInput, turn_id: "turn-1", prompt: "hi" }, env);
    await appendRollout(transcript, [
      rolloutLine(baseMs + 1000, "event_msg", { type: "task_started", turn_id: "turn-1" }),
      rolloutLine(baseMs + 1000, "turn_context", { turn_id: "turn-1", model: "gpt-5.5" }),
      rolloutLine(baseMs + 1100, "event_msg", { type: "user_message", message: "hi" }),
      rolloutLine(baseMs + 5000, "response_item", { type: "reasoning", id: "rs_1" }),
      rolloutLine(baseMs + 7000, "event_msg", { type: "agent_message", message: "done" }),
      rolloutLine(baseMs + 7100, "event_msg", { type: "task_complete", turn_id: "turn-1", duration_ms: 6100, time_to_first_token_ms: 14988 })
    ]);
    await runCodexHook("Stop", { ...baseInput, turn_id: "turn-1" }, env);

    assert.equal(received.length, 1);
    const success = received[0]!;
    assert.equal(success.ok, true);
    assert.equal(success.client, "codex");
    assert.equal(success.modelClass, "gpt-5.5");
    assert.equal(success.assistantStartBucket, "10_30s");
    assert.equal(success.errorType, "none");
    assert.equal(success.targetHost, primaryTargetHost);
    assert.equal("session_id" in success, false);
    assert.equal("transcriptPath" in success, false);

    // Turn 2: fails without a Stop hook; the next prompt settles it.
    await runCodexHook("UserPromptSubmit", { ...baseInput, turn_id: "turn-2", prompt: "again" }, env);
    await appendRollout(transcript, [
      rolloutLine(baseMs + 10000, "event_msg", { type: "task_started", turn_id: "turn-2" }),
      rolloutLine(baseMs + 10000, "turn_context", { turn_id: "turn-2", model: "gpt-5.5" }),
      rolloutLine(baseMs + 10100, "event_msg", { type: "user_message", message: "again" }),
      rolloutLine(baseMs + 15000, "event_msg", { type: "error", message: `unexpected status 503 Service Unavailable: no channel, url: ${targetResponsesUrl}, request id: 20260702`, codex_error_info: "other" }),
      rolloutLine(baseMs + 15001, "event_msg", { type: "task_complete", turn_id: "turn-2", duration_ms: 5001 })
    ]);
    await runCodexHook("UserPromptSubmit", { ...baseInput, turn_id: "turn-3", prompt: "retry" }, env);

    assert.equal(received.length, 2);
    const failure = received[1]!;
    assert.equal(failure.ok, false);
    assert.equal(failure.client, "codex");
    assert.equal(failure.errorType, "server_error");
    assert.equal(failure.errorStatusCode, 503);
    assert.equal(typeof failure.errorHint, "string");
    assert.equal(failure.errorHint.includes(primaryTargetHost), false);
    assert.equal(failure.assistantStartBucket, "unknown");

    // Turn 3: user interrupt is settled as a skip, not a report.
    await appendRollout(transcript, [
      rolloutLine(baseMs + 20000, "event_msg", { type: "task_started", turn_id: "turn-3" }),
      rolloutLine(baseMs + 21000, "event_msg", { type: "turn_aborted", turn_id: "turn-3", reason: "interrupted" })
    ]);
    await runCodexHook("Stop", { ...baseInput, turn_id: "turn-3" }, env);
    assert.equal(received.length, 2);

    // Off-target provider: nothing is reported.
    const otherHome = await mkdtemp(join(tmpdir(), "codex-home-other-"));
    await writeFile(join(otherHome, "config.toml"), [
      'model_provider = "other"',
      "[model_providers.other]",
      'base_url = "https://api.other.example/v1"'
    ].join("\n") + "\n", "utf8");
    const otherTranscript = join(stateDir, "rollout-other.jsonl");
    await writeFile(otherTranscript, rolloutLine(baseMs, "session_meta", {
      session_id: "codex-session-other",
      model_provider: "other"
    }) + "\n", "utf8");
    const otherEnv = { ...env, CODEX_HOME: otherHome };
    const otherInput = { ...baseInput, session_id: "codex-session-other", transcript_path: otherTranscript };
    await runCodexHook("UserPromptSubmit", { ...otherInput, turn_id: "turn-x" }, otherEnv);
    await appendRollout(otherTranscript, [
      rolloutLine(baseMs + 1000, "event_msg", { type: "task_started", turn_id: "turn-x" }),
      rolloutLine(baseMs + 2000, "event_msg", { type: "agent_message", message: "ok" }),
      rolloutLine(baseMs + 2100, "event_msg", { type: "task_complete", turn_id: "turn-x", duration_ms: 1100, time_to_first_token_ms: 900 })
    ]);
    await runCodexHook("Stop", { ...otherInput, turn_id: "turn-x" }, otherEnv);
    assert.equal(received.length, 2);
  } finally {
    server.close();
  }
});

test("codex watcher reports a failed turn without a later hook", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-watcher-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-watcher-"));
  await writeTargetCodexConfig(codexHome);
  const sessionId = "codex-watcher-owner";
  const sessionKey = hashLocalSessionId(sessionId);
  const transcript = join(stateDir, "rollout-watcher.jsonl");
  const baseMs = Date.now();
  const env = {
    ...codexEnv(stateDir, codexHome, server),
    ROUTER_VITALS_TEST_DISABLE_CODEX_WATCHER: "0"
  };

  try {
    await writeFile(transcript, [
      rolloutLine(baseMs, "session_meta", { session_id: sessionId, model_provider: providerId }),
      rolloutLine(baseMs + 1, "event_msg", { type: "task_started", turn_id: "turn-watched" }),
      rolloutLine(baseMs + 2, "turn_context", { turn_id: "turn-watched", model: "gpt-5.5" })
    ].join("\n") + "\n", "utf8");

    await runCodexHook("UserPromptSubmit", {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: stateDir,
      model: "gpt-5.5",
      turn_id: "turn-watched",
      prompt: "retry"
    }, env);

    await appendRollout(transcript, [
      rolloutLine(baseMs + 100, "event_msg", {
        type: "error",
        message: `unexpected status 429 Too Many Requests, url: ${targetResponsesUrl}`
      }),
      rolloutLine(baseMs + 101, "event_msg", { type: "task_complete", turn_id: "turn-watched", duration_ms: 100 })
    ]);

    await waitFor(async () => received.length === 1);
    await waitFor(async () => (await readPluginState(stateDir)).pending[sessionKey] === undefined);
    assert.equal(received[0]!.ok, false);
    assert.equal(received[0]!.errorType, "rate_limited");
    assert.equal(received[0]!.errorStatusCode, 429);
    assert.equal(received[0]!.client, "codex");

    const state = await readPluginState(stateDir);
    assert.equal(state.lastDecision?.eventName, "CodexWatcher");
    await runCodexHook("SessionStart", {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: stateDir,
      model: "gpt-5.5"
    }, env);
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test("concurrent Codex settlements consume a pending turn once", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-concurrent-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-concurrent-"));
  await writeTargetCodexConfig(codexHome);
  const env = codexEnv(stateDir, codexHome, server);
  const sessionId = "codex-concurrent";
  const transcript = join(stateDir, "rollout-concurrent.jsonl");
  const baseMs = Date.now();
  const input = {
    session_id: sessionId,
    transcript_path: transcript,
    cwd: stateDir,
    model: "gpt-5.5",
    turn_id: "turn-concurrent"
  };

  try {
    await writeFile(transcript, [
      rolloutLine(baseMs, "session_meta", { session_id: sessionId, model_provider: providerId }),
      rolloutLine(baseMs + 1, "event_msg", { type: "task_started", turn_id: "turn-concurrent" }),
      rolloutLine(baseMs + 2, "turn_context", { turn_id: "turn-concurrent", model: "gpt-5.5" })
    ].join("\n") + "\n", "utf8");
    await runCodexHook("UserPromptSubmit", input, env);
    await appendRollout(transcript, [
      rolloutLine(baseMs + 100, "event_msg", { type: "agent_message", message: "done" }),
      rolloutLine(baseMs + 101, "event_msg", { type: "task_complete", turn_id: "turn-concurrent", duration_ms: 100 })
    ]);

    await Promise.all([
      runCodexHook("Stop", input, env),
      runCodexHook("Stop", input, env)
    ]);

    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test("codex hook cross-settles a stale pending turn from another session", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-cross-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-cross-"));
  await writeTargetCodexConfig(codexHome);
  const env = codexEnv(stateDir, codexHome, server);
  const ownerSessionId = "codex-cross-owner";
  const ownerSessionKey = hashLocalSessionId(ownerSessionId);
  const ownerTranscript = join(stateDir, "rollout-cross-owner.jsonl");
  const baseMs = Date.now() - 3 * 60 * 1000;

  try {
    await writeFile(ownerTranscript, rolloutLine(baseMs, "session_meta", {
      session_id: ownerSessionId,
      model_provider: providerId
    }) + "\n", "utf8");
    await runCodexHook("UserPromptSubmit", {
      session_id: ownerSessionId,
      transcript_path: ownerTranscript,
      cwd: stateDir,
      model: "unclassified-model",
      turn_id: "turn-stale",
      prompt: "hi"
    }, env);

    let state = await readPluginState(stateDir);
    assert.equal(state.pending[ownerSessionKey]?.transcriptPath, ownerTranscript);

    await appendRollout(ownerTranscript, [
      rolloutLine(baseMs + 1000, "event_msg", { type: "task_started", turn_id: "turn-stale" }),
      rolloutLine(baseMs + 1000, "turn_context", { turn_id: "turn-stale", model: "unclassified-model" }),
      rolloutLine(baseMs + 2000, "event_msg", { type: "task_complete", turn_id: "turn-stale", duration_ms: 1000 })
    ]);
    await agePending(stateDir, ownerSessionKey, 6 * 60 * 1000);

    await triggerCodexSessionStart("codex-cross-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.ok, false);
    assert.equal(received[0]!.errorType, "unknown");
    assert.equal(received[0]!.client, "codex");
    assert.equal(received[0]!.modelClass, "unknown");

    state = await readPluginState(stateDir);
    assert.equal(state.pending[ownerSessionKey], undefined);
  } finally {
    server.close();
  }
});

test("codex hook keeps cross-session pending while rollout turn is still running", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-running-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-running-"));
  await writeTargetCodexConfig(codexHome);
  const ownerSessionId = "codex-running-owner";
  const ownerSessionKey = hashLocalSessionId(ownerSessionId);
  const ownerTranscript = join(stateDir, "rollout-running-owner.jsonl");
  const startedAtMs = Date.now() - 6 * 60 * 1000;

  try {
    await writeFile(ownerTranscript, [
      rolloutLine(startedAtMs, "session_meta", { session_id: ownerSessionId, model_provider: providerId }),
      rolloutLine(startedAtMs + 1000, "event_msg", { type: "task_started", turn_id: "turn-running" }),
      rolloutLine(startedAtMs + 1000, "turn_context", { turn_id: "turn-running", model: "gpt-5.5" })
    ].join("\n") + "\n", "utf8");
    await writePluginState(stateDir, {
      pending: {
        [ownerSessionKey]: stalePending(ownerTranscript, "turn-running", startedAtMs)
      }
    });

    await triggerCodexSessionStart("codex-running-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 0);
    const state = await readPluginState(stateDir);
    assert.equal(Boolean(state.pending[ownerSessionKey]), true);
  } finally {
    server.close();
  }
});

test("codex hook does not let running turns starve completed cross-session work", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-starvation-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-starvation-"));
  await writeTargetCodexConfig(codexHome);
  const baseMs = Date.now() - 5 * 60 * 1000;
  const pending: Record<string, unknown> = {};
  const ownerKeys: string[] = [];

  try {
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `codex-starvation-${index}`;
      const sessionKey = hashLocalSessionId(sessionId);
      const turnId = `turn-starvation-${index}`;
      const transcript = join(stateDir, `rollout-starvation-${index}.jsonl`);
      const startedAtMs = baseMs + index * 1000;
      const lines = [
        rolloutLine(startedAtMs, "session_meta", { session_id: sessionId, model_provider: providerId }),
        rolloutLine(startedAtMs + 100, "event_msg", { type: "task_started", turn_id: turnId })
      ];
      if (index === 2) {
        lines.push(rolloutLine(startedAtMs + 200, "event_msg", { type: "task_complete", turn_id: turnId, duration_ms: 100 }));
      }
      await writeFile(transcript, lines.join("\n") + "\n", "utf8");
      pending[sessionKey] = stalePending(transcript, turnId, startedAtMs);
      ownerKeys.push(sessionKey);
    }
    await writePluginState(stateDir, { pending });

    await triggerCodexSessionStart("codex-starvation-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 1);
    const state = await readPluginState(stateDir);
    assert.ok(state.pending[ownerKeys[0]!]);
    assert.ok(state.pending[ownerKeys[1]!]);
    assert.equal(state.pending[ownerKeys[2]!], undefined);
  } finally {
    server.close();
  }
});

test("codex hook drops malformed pending state", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-malformed-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-malformed-"));
  await writeTargetCodexConfig(codexHome);
  const ownerSessionKey = hashLocalSessionId("codex-malformed-owner");
  const startedAtMs = Date.now() - 6 * 60 * 1000;

  try {
    await writePluginState(stateDir, {
      pending: {
        [ownerSessionKey]: {
          startedAtMs,
          targetMatched: true,
          turnId: "turn-malformed",
          modelClass: "gpt-5.5"
        }
      }
    });

    await triggerCodexSessionStart("codex-malformed-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 0);
    const state = await readPluginState(stateDir);
    assert.equal(state.pending[ownerSessionKey], undefined);
  } finally {
    server.close();
  }
});

test("codex hook processes at most two stale cross-session pending turns per event", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-cross-limit-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-cross-limit-"));
  await writeTargetCodexConfig(codexHome);
  const baseMs = Date.now() - 10 * 60 * 1000;
  const pending: Record<string, unknown> = {};
  const ownerKeys: string[] = [];

  try {
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `codex-limit-owner-${index}`;
      const sessionKey = hashLocalSessionId(sessionId);
      const turnId = `turn-limit-${index}`;
      const transcript = join(stateDir, `rollout-limit-${index}.jsonl`);
      const startedAtMs = baseMs + index * 1000;
      ownerKeys.push(sessionKey);
      await writeFile(transcript, [
        rolloutLine(startedAtMs, "session_meta", { session_id: sessionId, model_provider: providerId }),
        rolloutLine(startedAtMs + 100, "event_msg", { type: "task_started", turn_id: turnId }),
        rolloutLine(startedAtMs + 200, "event_msg", { type: "task_complete", turn_id: turnId, duration_ms: 100 })
      ].join("\n") + "\n", "utf8");
      pending[sessionKey] = stalePending(transcript, turnId, startedAtMs);
    }
    await writePluginState(stateDir, { pending });

    await triggerCodexSessionStart("codex-limit-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 2);
    const state = await readPluginState(stateDir);
    assert.equal(Boolean(state.pending[ownerKeys[0]!]), false);
    assert.equal(Boolean(state.pending[ownerKeys[1]!]), false);
    assert.equal(Boolean(state.pending[ownerKeys[2]!]), true);
  } finally {
    server.close();
  }
});

test("codex hook immediately cross-settles a recently finished turn", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-grace-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-grace-"));
  await writeTargetCodexConfig(codexHome);
  const ownerSessionId = "codex-grace-owner";
  const ownerSessionKey = hashLocalSessionId(ownerSessionId);
  const transcript = join(stateDir, "rollout-grace-owner.jsonl");
  const startedAtMs = Date.now() - 10 * 60 * 1000;
  const completedAtMs = Date.now() - 10_000;

  try {
    await writeFile(transcript, [
      rolloutLine(startedAtMs, "session_meta", { session_id: ownerSessionId, model_provider: providerId }),
      rolloutLine(startedAtMs + 100, "event_msg", { type: "task_started", turn_id: "turn-grace" }),
      rolloutLine(completedAtMs, "event_msg", { type: "task_complete", turn_id: "turn-grace", duration_ms: 100 })
    ].join("\n") + "\n", "utf8");
    await writePluginState(stateDir, {
      pending: {
        [ownerSessionKey]: stalePending(transcript, "turn-grace", startedAtMs)
      }
    });

    await triggerCodexSessionStart("codex-grace-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 1);
    const state = await readPluginState(stateDir);
    assert.equal(state.pending[ownerSessionKey], undefined);
  } finally {
    server.close();
  }
});

test("codex hook consumes expired cross-session pending without reporting it", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-expired-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-expired-"));
  await writeTargetCodexConfig(codexHome);
  const ownerSessionId = "codex-expired-owner";
  const ownerSessionKey = hashLocalSessionId(ownerSessionId);
  const transcript = join(stateDir, "rollout-expired-owner.jsonl");
  const startedAtMs = Date.now() - 20 * 60 * 1000;

  try {
    await writeFile(transcript, [
      rolloutLine(startedAtMs, "session_meta", { session_id: ownerSessionId, model_provider: providerId }),
      rolloutLine(startedAtMs + 100, "event_msg", { type: "task_started", turn_id: "turn-expired" }),
      rolloutLine(startedAtMs + 200, "event_msg", { type: "task_complete", turn_id: "turn-expired", duration_ms: 100 })
    ].join("\n") + "\n", "utf8");
    await writePluginState(stateDir, {
      pending: {
        [ownerSessionKey]: stalePending(transcript, "turn-expired", startedAtMs)
      }
    });

    await triggerCodexSessionStart("codex-expired-trigger", stateDir, codexHome, server);

    assert.equal(received.length, 0);
    const state = await readPluginState(stateDir);
    assert.equal(state.pending[ownerSessionKey], undefined);
    assert.equal(state.lastDecision?.reason, "pending_expired");
  } finally {
    server.close();
  }
});

test("codex hook reports long-running turns based on last activity time", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createCodexReportServer(received);
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-long-turn-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-long-turn-"));
  await writeTargetCodexConfig(codexHome);
  const env = codexEnv(stateDir, codexHome, server);
  const sessionId = "codex-long-turn";
  const sessionKey = hashLocalSessionId(sessionId);
  const transcript = join(stateDir, "rollout-long-turn.jsonl");
  const startedAtMs = Date.now() - 40 * 60 * 1000;
  const completedAtMs = Date.now() - 1000;

  try {
    await writeFile(transcript, rolloutLine(startedAtMs - 1000, "session_meta", {
      session_id: sessionId,
      model_provider: providerId
    }) + "\n", "utf8");
    await runCodexHook("UserPromptSubmit", {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: stateDir,
      model: "gpt-5.5",
      turn_id: "turn-long",
      prompt: "long job"
    }, env);
    await agePending(stateDir, sessionKey, 40 * 60 * 1000);
    await appendRollout(transcript, [
      rolloutLine(startedAtMs, "event_msg", { type: "task_started", turn_id: "turn-long" }),
      rolloutLine(startedAtMs, "turn_context", { turn_id: "turn-long", model: "gpt-5.5" }),
      rolloutLine(completedAtMs - 1000, "response_item", { type: "reasoning", id: "rs_long" }),
      rolloutLine(completedAtMs, "event_msg", { type: "task_complete", turn_id: "turn-long", duration_ms: 40 * 60 * 1000 })
    ]);

    await runCodexHook("Stop", {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: stateDir,
      model: "gpt-5.5",
      turn_id: "turn-long"
    }, env);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.ok, true);
    assert.equal(received[0]!.client, "codex");
    assert.equal(received[0]!.errorType, "none");
    const state = await readPluginState(stateDir);
    assert.equal(state.pending[sessionKey], undefined);
  } finally {
    server.close();
  }
});

test("codex hook emits low-frequency update reminders via Stop systemMessage", async () => {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: `http://127.0.0.1:${serverPort(server)}`,
        latestPluginVersion: "9.9.9"
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(server);

  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-codex-reminder-"));
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-reminder-"));
  await writeFile(join(codexHome, "config.toml"), 'model_provider = "other"\n', "utf8");
  const transcript = join(stateDir, "rollout-reminder.jsonl");
  await writeFile(transcript, rolloutLine(Date.now() - 1000, "session_meta", {
    session_id: "codex-reminder",
    model_provider: "other"
  }) + "\n", "utf8");

  const env = {
    ...process.env,
    ROUTER_VITALS_STATE_DIR: stateDir,
    ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
    CODEX_HOME: codexHome
  };
  const input = { session_id: "codex-reminder", transcript_path: transcript, cwd: stateDir, model: "gpt-5.5", turn_id: "turn-r" };

  try {
    const firstStop = await runCodexHook("Stop", input, env);
    const message = JSON.parse(firstStop.trim());
    assert.equal(typeof message.systemMessage, "string");
    assert.equal(message.systemMessage.includes("9.9.9"), true);
    assert.equal(message.systemMessage.includes(`codex plugin marketplace upgrade ${MARKETPLACE_NAME}`), true);
    assert.equal(message.systemMessage.includes(`codex plugin add ${PLUGIN_FULL_ID}`), true);

    const secondStop = await runCodexHook("Stop", input, env);
    assert.equal(secondStop.trim(), "");
  } finally {
    server.close();
  }
});

function createCodexReportServer(received: Array<Record<string, any>>): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: `http://127.0.0.1:${serverPort(server)}`,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["60m"]
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/report") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        respondJson(res, { ok: true });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

async function writeTargetCodexConfig(codexHome: string): Promise<void> {
  await writeFile(join(codexHome, "config.toml"), [
    'model = "gpt-5.5"',
    `model_provider = "${providerId}"`,
    `[model_providers.${providerId}]`,
    `base_url = "${targetBaseUrl}"`
  ].join("\n") + "\n", "utf8");
}

function codexEnv(stateDir: string, codexHome: string, server: Server): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ROUTER_VITALS_STATE_DIR: stateDir,
    ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
    CODEX_HOME: codexHome
  };
}

async function triggerCodexSessionStart(
  sessionId: string,
  stateDir: string,
  codexHome: string,
  server: Server
): Promise<void> {
  const transcript = join(stateDir, `rollout-${sessionId}.jsonl`);
  await writeFile(transcript, rolloutLine(Date.now(), "session_meta", {
    session_id: sessionId,
    model_provider: providerId
  }) + "\n", "utf8");
  await runCodexHook("SessionStart", {
    session_id: sessionId,
    transcript_path: transcript,
    cwd: stateDir,
    model: "gpt-5.5"
  }, codexEnv(stateDir, codexHome, server));
}

function stalePending(transcriptPath: string, turnId: string, startedAtMs: number): Record<string, unknown> {
  return {
    client: "codex",
    settlementId: randomUUID(),
    startedAtMs,
    targetMatched: true,
    turnId,
    transcriptPath,
    transcriptStartOffset: 0,
    modelClass: "gpt-5.5"
  };
}

async function agePending(stateDir: string, sessionKey: string, ageMs: number): Promise<void> {
  const state = await readPluginState(stateDir);
  assert.ok(state.pending[sessionKey]);
  state.pending[sessionKey].startedAtMs = Date.now() - ageMs;
  await writePluginState(stateDir, state);
}

async function readPluginState(stateDir: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(pluginStatePath(stateDir), "utf8"));
}

async function writePluginState(stateDir: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(stateDir, PLUGIN_ID), { recursive: true });
  await writeFile(pluginStatePath(stateDir), `${JSON.stringify({ ...state, version: 2 }, null, 2)}\n`, "utf8");
}

function pluginStatePath(stateDir: string): string {
  return join(stateDir, PLUGIN_ID, "state.json");
}

function rolloutLine(timestampMs: number, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date(timestampMs).toISOString(), type, payload });
}

async function appendRollout(path: string, lines: string[]): Promise<void> {
  await appendFile(path, lines.join("\n") + "\n", "utf8");
}

async function runCodexHook(eventName: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [hookPath, eventName, "--client=codex"], {
      env: {
        ...env,
        ROUTER_VITALS_TEST_DISABLE_CODEX_WATCHER: env.ROUTER_VITALS_TEST_DISABLE_CODEX_WATCHER ?? "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`codex hook timed out: ${eventName}`));
    }, 10000);

    child.stdin.end(JSON.stringify(input));
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun(Buffer.concat(chunks).toString("utf8"));
      else rejectRun(new Error(`codex hook exited with code ${code}: ${eventName}: ${Buffer.concat(errors).toString("utf8")}`));
    });
  });
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function respondJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function serverPort(server: Server): number {
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("server is not listening");
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}
