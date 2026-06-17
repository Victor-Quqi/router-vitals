import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LOCAL_DAILY_REPORT_LIMIT } from "../plugin/scripts/lib/policy.mjs";
const hookPath = resolve("plugin/scripts/hook.mjs");
test("plugin hook uploads only for matched AnyRouter sessions", async () => {
    const received = [];
    const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/config.json") {
            const base = `http://127.0.0.1:${serverPort(server)}`;
            respondJson(res, {
                reportingEnabled: true,
                apiBaseUrl: base,
                targetBaseUrlHosts: ["anyrouter.top", "a-ocnfniawgw.cn-shanghai.fcapp.run"],
                sampleRateSuccess: 1,
                sampleRateFailure: 1,
                minPluginVersion: "0.1.0",
                statusWindows: ["5m", "15m", "60m"]
            });
            return;
        }
        if (req.method === "POST" && req.url === "/v1/report") {
            const chunks = [];
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
            ANYROUTER_STATUS_STATE_DIR: stateDir,
            ANYROUTER_STATUS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`
        };
        await runHook("SessionStart", { session_id: "session-a", model: "claude-sonnet-4" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
        const sessionATranscript = join(stateDir, "session-a.jsonl");
        await writeTranscriptModel(sessionATranscript, "claude-sonnet-4");
        await runHook("UserPromptSubmit", { session_id: "session-a" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
        await runHook("Stop", { session_id: "session-a", transcript_path: sessionATranscript }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top/v1/messages"
        });
        assert.equal(received.length, 1);
        const payload = received[0];
        assert.equal(payload.ok, true);
        assert.equal(payload.targetMatched, true);
        assert.equal(payload.modelClass, "sonnet");
        assert.equal(payload.errorStatusCode, null);
        assert.equal(payload.errorHint, null);
        assert.equal(payload.targetHost, "anyrouter.top");
        assert.equal("baseUrl" in payload, false);
        assert.equal("session_id" in payload, false);
        await runHook("SessionStart", { session_id: "session-c", model: "claude-opus-4-1-20250805" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
        const sessionCTranscript = join(stateDir, "session-c.jsonl");
        await writeTranscriptModel(sessionCTranscript, "claude-3-5-haiku-latest");
        await runHook("UserPromptSubmit", { session_id: "session-c" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
        await runHook("Stop", { session_id: "session-c", transcript_path: sessionCTranscript }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top/v1/messages"
        });
        assert.equal(received.length, 2);
        assert.equal(received[1].modelClass, "haiku");
        const sessionDTranscript = join(stateDir, "session-d.jsonl");
        await writeTranscriptModel(sessionDTranscript, "claude-3-5-haiku-latest");
        await runHook("UserPromptSubmit", { session_id: "session-d" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
        await runHook("Stop", { session_id: "session-d", transcript_path: sessionDTranscript }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top/v1/messages"
        });
        assert.equal(received.length, 3);
        assert.equal(received[2].modelClass, "haiku");
        const sessionETranscript = join(stateDir, "session-e.jsonl");
        await writeTranscriptModel(sessionETranscript, "claude-opus-4-1-20250805", "2000-01-01T00:00:00.000Z");
        await runHook("UserPromptSubmit", { session_id: "session-e" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
        await runHook("StopFailure", { session_id: "session-e", transcript_path: sessionETranscript, message: "server 500" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top/v1/messages"
        });
        assert.equal(received.length, 4);
        assert.equal(received[3].modelClass, "unknown");
        await runHook("UserPromptSubmit", { session_id: "session-b" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://api.anthropic.com"
        });
        await runHook("StopFailure", { session_id: "session-b", message: "server 500" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://api.anthropic.com"
        });
        assert.equal(received.length, 4);
        await runHook("SessionEnd", { session_id: "session-a" }, {
            ...commonEnv,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        });
    }
    finally {
        server.close();
        await rm(stateDir, { recursive: true, force: true });
    }
});
test("plugin hook skips uploads after the local daily contribution limit", async () => {
    const received = [];
    const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/config.json") {
            const base = `http://127.0.0.1:${serverPort(server)}`;
            respondJson(res, {
                reportingEnabled: true,
                apiBaseUrl: base,
                targetBaseUrlHosts: ["anyrouter.top", "a-ocnfniawgw.cn-shanghai.fcapp.run"],
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
    const statePath = join(stateDir, "anyrouter-status-monitor", "state.json");
    const today = new Date().toISOString().slice(0, 10);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
        version: 1,
        contributions: { [today]: LOCAL_DAILY_REPORT_LIMIT }
    }), "utf8");
    try {
        const commonEnv = {
            ...process.env,
            ANYROUTER_STATUS_STATE_DIR: stateDir,
            ANYROUTER_STATUS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
            ANTHROPIC_BASE_URL: "https://anyrouter.top"
        };
        await runHook("UserPromptSubmit", { session_id: "session-limit" }, commonEnv);
        await runHook("Stop", { session_id: "session-limit" }, commonEnv);
        assert.equal(received.length, 0);
    }
    finally {
        server.close();
        await rm(stateDir, { recursive: true, force: true });
    }
});
async function writeTranscriptModel(path, model, timestamp) {
    await writeFile(path, `${JSON.stringify({
        type: "assistant",
        ...(timestamp ? { timestamp } : {}),
        message: {
            role: "assistant",
            model
        }
    })}\n`, "utf8");
}
async function runHook(eventName, input, env) {
    await new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [hookPath, eventName], {
            env,
            stdio: ["pipe", "pipe", "pipe"]
        });
        const timeout = setTimeout(() => {
            child.kill();
            rejectRun(new Error(`hook timed out: ${eventName}`));
        }, 10000);
        child.stdin.end(JSON.stringify(input));
        child.on("error", rejectRun);
        child.on("exit", (code) => {
            clearTimeout(timeout);
            if (code === 0)
                resolveRun();
            else
                rejectRun(new Error(`hook exited with code ${code}: ${eventName}`));
        });
    });
}
function listen(server) {
    return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}
function respondJson(res, value) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
}
function serverPort(server) {
    const address = server.address();
    if (!address)
        throw new Error("server is not listening");
    return address.port;
}
