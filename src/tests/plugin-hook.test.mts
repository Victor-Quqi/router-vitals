import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LOCAL_DAILY_REPORT_LIMIT, TARGET_HOSTS, getTodayKey } from "../plugin/scripts/lib/policy.mjs";
import { PLUGIN_FULL_ID, PLUGIN_ID } from "../shared/site-config.mjs";

const hookPath = resolve("plugin/scripts/hook.mjs");
const primaryTargetHost = TARGET_HOSTS[0]!;
const secondaryTargetHost = TARGET_HOSTS[1]!;
const primaryTargetBaseUrl = `https://${primaryTargetHost}`;
const primaryTargetMessagesUrl = `${primaryTargetBaseUrl}/v1/messages`;

test("plugin hook uploads only for matched target sessions", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
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
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-"));

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`
    };

    await runHook("SessionStart", { session_id: "session-a", model: "claude-sonnet-4-6" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    const sessionATranscript = join(stateDir, "session-a.jsonl");
    await runHook("UserPromptSubmit", { session_id: "session-a" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    await writeTranscriptModel(sessionATranscript, "claude-sonnet-4-6");
    await runHook("Stop", { session_id: "session-a", transcript_path: sessionATranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl
    });

    assert.equal(received.length, 1);
    const payload = received[0]!;
    assert.equal(payload.ok, true);
    assert.equal(payload.targetMatched, true);
    assert.equal(payload.modelClass, "sonnet");
    assert.equal(payload.assistantStartBucket, "lt_3s");
    assert.equal(payload.errorStatusCode, null);
    assert.equal(payload.errorHint, null);
    assert.equal(payload.targetHost, primaryTargetHost);
    assert.equal("latencyBucket" in payload, false);
    assert.equal("baseUrl" in payload, false);
    assert.equal("session_id" in payload, false);

    await runHook("SessionStart", { session_id: "session-c", model: "claude-opus-4-8" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    const sessionCTranscript = join(stateDir, "session-c.jsonl");
    await runHook("UserPromptSubmit", { session_id: "session-c" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    await writeTranscriptModel(sessionCTranscript, "claude-haiku-4-5-20251001");
    await runHook("Stop", { session_id: "session-c", transcript_path: sessionCTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl
    });

    assert.equal(received.length, 2);
    assert.equal(received[1]!.modelClass, "haiku");

    const sessionDTranscript = join(stateDir, "session-d.jsonl");
    await runHook("UserPromptSubmit", { session_id: "session-d" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    await writeTranscriptModel(sessionDTranscript, "claude-haiku-4-5-20251001");
    await runHook("Stop", { session_id: "session-d", transcript_path: sessionDTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl
    });

    assert.equal(received.length, 3);
    assert.equal(received[2]!.modelClass, "haiku");

    const sessionETranscript = join(stateDir, "session-e.jsonl");
    await writeTranscriptModel(sessionETranscript, "claude-opus-4-8", "2000-01-01T00:00:00.000Z");
    await runHook("UserPromptSubmit", { session_id: "session-e" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    await runHook("StopFailure", { session_id: "session-e", transcript_path: sessionETranscript, message: "server 500" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl
    });

    assert.equal(received.length, 4);
    assert.equal(received[3]!.modelClass, "unknown");

    const sessionFTranscript = join(stateDir, "session-f.jsonl");
    await writeFile(sessionFTranscript, "", "utf8");
    await runHook("SessionStart", { session_id: "session-f" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("UserPromptSubmit", { session_id: "session-f", transcript_path: sessionFTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
    await runHook("StopFailure", {
      session_id: "session-f",
      transcript_path: sessionFTranscript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });

    assert.equal(received.length, 5);
    assert.equal(received[4]!.modelClass, "opus");
    assert.equal(received[4]!.errorType, "rate_limited");
    assert.equal(received[4]!.errorStatusCode, 429);

    const sessionGTranscript = join(stateDir, "session-g.jsonl");
    await writeTranscriptRecords(sessionGTranscript, [createModelSwitchCommandRecord()]);
    await runHook("SessionStart", { session_id: "session-g" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("UserPromptSubmit", { session_id: "session-g", transcript_path: sessionGTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("StopFailure", {
      session_id: "session-g",
      transcript_path: sessionGTranscript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });

    assert.equal(received.length, 6);
    assert.equal(received[5]!.modelClass, "opus");

    const sessionHTranscript = join(stateDir, "session-h.jsonl");
    await writeTranscriptRecords(sessionHTranscript, [
      createModelSwitchCommandRecord(),
      createModelSetOutputRecord("Set model to Sonnet 4.6 (1M context) and saved as your default for new sessions with max effort")
    ]);
    await runHook("SessionStart", { session_id: "session-h" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("UserPromptSubmit", { session_id: "session-h", transcript_path: sessionHTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("StopFailure", {
      session_id: "session-h",
      transcript_path: sessionHTranscript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });

    assert.equal(received.length, 7);
    assert.equal(received[6]!.modelClass, "sonnet");

    const sessionITranscript = join(stateDir, "session-i.jsonl");
    await writeTranscriptRecords(sessionITranscript, [
      createModelSwitchCommandRecord(),
      createModelSetOutputRecord("Set model to Opus 4.8 (1M context) and saved as your default for new sessions with high effort")
    ]);
    await runHook("SessionStart", { session_id: "session-i" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-sonnet-4-6"
    });
    await runHook("UserPromptSubmit", { session_id: "session-i", transcript_path: sessionITranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-sonnet-4-6"
    });
    await runHook("StopFailure", {
      session_id: "session-i",
      transcript_path: sessionITranscript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl,
      CLAUDE_MODEL: "claude-sonnet-4-6"
    });

    assert.equal(received.length, 8);
    assert.equal(received[7]!.modelClass, "opus");

    const sessionJTranscript = join(stateDir, "session-j.jsonl");
    await writeTranscriptRecords(sessionJTranscript, [
      createModelSwitchCommandRecord(),
      createUserModelSetOutputRecord("Set model to \u001b[1mMystery 1.0\u001b[22m and saved as your default for new sessions")
    ]);
    await runHook("SessionStart", { session_id: "session-j" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("UserPromptSubmit", { session_id: "session-j", transcript_path: sessionJTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("StopFailure", {
      session_id: "session-j",
      transcript_path: sessionJTranscript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });

    assert.equal(received.length, 9);
    assert.equal(received[8]!.modelClass, "unknown");

    const sessionKTranscript = join(stateDir, "session-k.jsonl");
    await writeTranscriptRecords(sessionKTranscript, [
      createModelSwitchCommandRecord(),
      createModelSetOutputRecord("Set model to Fable 5 and saved as your default for new sessions")
    ]);
    await runHook("SessionStart", { session_id: "session-k" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("UserPromptSubmit", { session_id: "session-k", transcript_path: sessionKTranscript }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });
    await runHook("StopFailure", {
      session_id: "session-k",
      transcript_path: sessionKTranscript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetMessagesUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    });

    assert.equal(received.length, 10);
    assert.equal(received[9]!.modelClass, "fable");

    await runHook("UserPromptSubmit", { session_id: "session-b" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: "https://api.anthropic.com"
    });
    await runHook("StopFailure", { session_id: "session-b", message: "server 500" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: "https://api.anthropic.com"
    });

    assert.equal(received.length, 10);

    await runHook("SessionEnd", { session_id: "session-a" }, {
      ...commonEnv,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    });
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook debug log records model resolution evidence", async () => {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/report") {
      respondJson(res, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await listen(server);
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-debug-"));

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_DEBUG_HOOK: "1",
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl,
      CLAUDE_MODEL: "claude-opus-4-8"
    };
    const transcript = join(stateDir, "session-debug.jsonl");
    const records = [
      createModelSwitchCommandRecord(),
      createUserModelSetOutputRecord("Set model to \u001b[1mSonnet 4.6 (1M context)\u001b[22m and saved as your default for new sessions")
    ];

    await runHook("SessionStart", { session_id: "session-debug" }, commonEnv);
    await writeTranscriptRecords(transcript, records);
    await runHook("UserPromptSubmit", { session_id: "session-debug", transcript_path: transcript }, commonEnv);
    records.push(createSyntheticAssistantErrorRecord(429));
    await writeTranscriptRecords(transcript, records);
    await runHook("StopFailure", {
      session_id: "session-debug",
      transcript_path: transcript,
      status_code: 429,
      message: "API Error 429: rate limit reached"
    }, commonEnv);

    const debugPath = join(stateDir, PLUGIN_ID, "debug-hook.jsonl");
    const debugRecords = (await readFile(debugPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const promptDebug = debugRecords.find((record) => record.eventName === "UserPromptSubmit" && record.stage === "prompt_start");
    assert.equal(promptDebug.data.promptModelClass, "sonnet");
    assert.equal(promptDebug.data.promptSource, "prompt_transcript");
    assert.equal(promptDebug.data.promptTranscript.modelSetOutputs[0].modelClass, "sonnet");
    assert.equal(promptDebug.data.promptTranscript.modelSetOutputs[0].hasAnsi, true);

    const stopReceived = debugRecords.find((record) => record.eventName === "StopFailure" && record.stage === "received");
    assert.equal(stopReceived.data.input.directInputModelClass, "unknown");
    assert.equal(stopReceived.data.input.errorStatusCode, 429);

    const completionDebug = debugRecords.find((record) => record.eventName === "StopFailure" && record.stage === "completion");
    assert.equal(completionDebug.data.modelResolution.modelClass, "sonnet");
    assert.equal(completionDebug.data.modelResolution.source, "fallback");
    assert.equal(completionDebug.data.payload.modelClass, "sonnet");
    assert.equal(completionDebug.data.transcript.modelObservations[0].candidates[0].value, "<synthetic>");
    assert.equal(completionDebug.data.transcript.modelObservations[0].modelClass, "unknown");
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook uses session model only for the first prompt when transcript is unavailable", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
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
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-unavailable-transcript-"));

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    };
    const transcript = join(stateDir, "session-unavailable-transcript.jsonl");

    await runHook("SessionStart", { session_id: "session-unavailable-transcript", model: "claude-opus-4-8[1m]" }, commonEnv);
    await runHook("UserPromptSubmit", { session_id: "session-unavailable-transcript" }, commonEnv);
    await writeTranscriptRecords(transcript, [createSyntheticAssistantErrorRecord(429)]);
    await runHook("StopFailure", {
      session_id: "session-unavailable-transcript",
      transcript_path: transcript,
      status_code: 429,
      message: "rate_limit"
    }, commonEnv);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.modelClass, "opus");
    assert.equal(received[0]!.errorType, "rate_limited");

    await runHook("UserPromptSubmit", { session_id: "session-unavailable-transcript" }, commonEnv);
    await writeTranscriptRecords(transcript, [createSyntheticAssistantErrorRecord(429)]);
    await runHook("StopFailure", {
      session_id: "session-unavailable-transcript",
      transcript_path: transcript,
      status_code: 429,
      message: "rate_limit"
    }, commonEnv);

    assert.equal(received.length, 2);
    assert.equal(received[1]!.modelClass, "unknown");
    assert.equal(received[1]!.errorType, "rate_limited");
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook restores known model across same-transcript session resume", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
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
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-resume-model-"));

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    };
    const sessionId = "session-resume-model";
    const transcript = join(stateDir, "session-resume-model.jsonl");
    const records = [createUserTextRecord("before resume")];

    await writeTranscriptRecords(transcript, records);
    await runHook("SessionStart", { session_id: sessionId, transcript_path: transcript, model: "claude-fable-5[1m]" }, commonEnv);
    await runHook("SessionEnd", { session_id: sessionId, transcript_path: transcript }, commonEnv);
    await runHook("SessionStart", { session_id: sessionId, transcript_path: transcript }, commonEnv);
    await runHook("UserPromptSubmit", { session_id: sessionId, transcript_path: transcript }, commonEnv);

    records.push(createSyntheticAssistantErrorRecord(429));
    await writeTranscriptRecords(transcript, records);
    await runHook("StopFailure", {
      session_id: sessionId,
      transcript_path: transcript,
      status_code: 429,
      message: "rate_limit"
    }, commonEnv);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.modelClass, "fable");
    assert.equal(received[0]!.errorType, "rate_limited");
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook clears stale model after an unparsed model switch", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
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
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-unparsed-switch-"));

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    };
    const sessionId = "session-unparsed-switch";
    const transcript = join(stateDir, "session-unparsed-switch.jsonl");
    const records = [
      createModelSwitchCommandRecord(),
      createUserModelSetOutputRecord("Set model to \u001b[1mMystery 1.0\u001b[22m and saved as your default for new sessions")
    ];

    await runHook("SessionStart", { session_id: sessionId, transcript_path: transcript, model: "claude-fable-5[1m]" }, commonEnv);
    await writeTranscriptRecords(transcript, records);
    await runHook("UserPromptSubmit", { session_id: sessionId, transcript_path: transcript }, commonEnv);

    records.push(createSyntheticAssistantErrorRecord(429));
    await writeTranscriptRecords(transcript, records);
    await runHook("StopFailure", {
      session_id: sessionId,
      transcript_path: transcript,
      status_code: 429,
      message: "rate_limit"
    }, commonEnv);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.modelClass, "unknown");

    const statePath = join(stateDir, PLUGIN_ID, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const sessions = Object.values(state.sessions) as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 1);
    assert.equal("modelClass" in sessions[0]!, false);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook emits low-frequency update reminders", async () => {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        latestPluginVersion: "9.9.9",
        statusWindows: ["5m", "15m", "60m"]
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/report") {
      respondJson(res, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await listen(server);
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-update-"));

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    };

    await runHook("UserPromptSubmit", { session_id: "session-update-a" }, commonEnv);
    const first = await runHook("Stop", { session_id: "session-update-a" }, commonEnv);
    const firstOutput = JSON.parse(first);
    assert.match(firstOutput.systemMessage, /插件有新版 9\.9\.9/);
    assert.match(firstOutput.systemMessage, new RegExp(`/plugin update ${escapeRegExp(PLUGIN_FULL_ID)}`));

    await runHook("UserPromptSubmit", { session_id: "session-update-b" }, commonEnv);
    const second = await runHook("Stop", { session_id: "session-update-b" }, commonEnv);
    assert.equal(second.trim(), "");

    const statePath = join(stateDir, PLUGIN_ID, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(Object.keys(state.updateReminder), ["latestPluginVersion", "remindedAtMs"]);
    assert.equal(state.updateReminder.latestPluginVersion, "9.9.9");
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook skips uploads after the local daily contribution limit", async () => {
  const received: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/report") {
      received.push({});
      respondJson(res, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await listen(server);
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-"));
  const statePath = join(stateDir, PLUGIN_ID, "state.json");
  const today = getTodayKey();

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    version: 1,
    contributions: { [today]: LOCAL_DAILY_REPORT_LIMIT }
  }), "utf8");

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    };

    await runHook("UserPromptSubmit", { session_id: "session-limit" }, commonEnv);
    await runHook("Stop", { session_id: "session-limit" }, commonEnv);

    assert.equal(received.length, 0);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.lastDecision.kind, "skipped");
    assert.equal(state.lastDecision.reason, "local_daily_limit");
    assert.equal(state.lastDecision.targetHost, primaryTargetHost);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plugin hook records structured report failures", async () => {
  let reportRequests = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config.json") {
      const base = `http://127.0.0.1:${serverPort(server)}`;
      respondJson(res, {
        reportingEnabled: true,
        apiBaseUrl: base,
        targetBaseUrlHosts: [primaryTargetHost, secondaryTargetHost],
        sampleRateSuccess: 1,
        sampleRateFailure: 1,
        minPluginVersion: "0.1.0",
        statusWindows: ["5m", "15m", "60m"]
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/report") {
      reportRequests += 1;
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "temporarily_unavailable" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await listen(server);
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-post-failure-"));
  const statePath = join(stateDir, PLUGIN_ID, "state.json");

  try {
    const commonEnv = {
      ...process.env,
      ROUTER_VITALS_STATE_DIR: stateDir,
      ROUTER_VITALS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: primaryTargetBaseUrl
    };

    await runHook("UserPromptSubmit", { session_id: "session-post-failure" }, commonEnv);
    await runHook("Stop", { session_id: "session-post-failure" }, commonEnv);

    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(reportRequests, 1);
    assert.equal(state.contributions?.[getTodayKey()] ?? 0, 0);
    assert.equal(state.lastPayload, null);
    assert.equal(state.lastReportAt, null);
    assert.equal(state.lastDecision.kind, "post_failed");
    assert.equal(state.lastDecision.reason, "http_error");
    assert.equal(state.lastDecision.postStatusCode, 503);
    assert.equal(state.lastDecision.targetHost, primaryTargetHost);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function writeTranscriptModel(path: string, model: string, timestamp?: string): Promise<void> {
  await writeTranscriptRecords(path, [createAssistantModelRecord(model, timestamp)]);
}

async function writeTranscriptRecords(path: string, records: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function createAssistantModelRecord(model: string, timestamp?: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: timestamp || new Date(Date.now() + 1000).toISOString(),
    message: {
      role: "assistant",
      model
    }
  };
}

function createUserTextRecord(text: string): Record<string, unknown> {
  return {
    type: "user",
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: text
    }
  };
}

function createModelSwitchCommandRecord(): Record<string, unknown> {
  return {
    type: "user",
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"
    }
  };
}

function createModelSetOutputRecord(text: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "local_command",
    timestamp: new Date().toISOString(),
    content: `<local-command-stdout>${text}</local-command-stdout>`
  };
}

function createUserModelSetOutputRecord(text: string): Record<string, unknown> {
  return {
    type: "user",
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: `<local-command-stdout>${text}</local-command-stdout>`
    }
  };
}

function createSyntheticAssistantErrorRecord(statusCode: number): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: new Date(Date.now() + 1000).toISOString(),
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: `API Error: Request rejected (${statusCode})` }]
    },
    isApiErrorMessage: true,
    apiErrorStatus: statusCode
  };
}

async function runHook(eventName: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [hookPath, eventName], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`hook timed out: ${eventName}`));
    }, 10000);

    child.stdin.end(JSON.stringify(input));
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun(Buffer.concat(chunks).toString("utf8"));
      else rejectRun(new Error(`hook exited with code ${code}: ${eventName}: ${Buffer.concat(errors).toString("utf8")}`));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
