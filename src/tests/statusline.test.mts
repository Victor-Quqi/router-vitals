import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const statuslinePath = resolve("plugin/scripts/statusline.mjs");

test("statusLine prints today's local contribution count", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-statusline-"));
  const statePath = join(stateDir, "anyrouter-status-monitor", "state.json");
  const today = new Date().toISOString().slice(0, 10);

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    version: 1,
    contributions: { [today]: 2 }
  }), "utf8");

  try {
    const output = await runStatusLine({
      ...process.env,
      ANYROUTER_STATUS_DISABLED: "1",
      ANYROUTER_STATUS_STATE_DIR: stateDir,
      ANTHROPIC_BASE_URL: "https://api.anthropic.com"
    });
    assert.match(output, /今日贡献 2 条/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("statusLine caches remote status between invocations", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-statusline-"));
  let statusRequests = 0;
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
        statusWindows: ["60m"]
      });
      return;
    }

    if (req.method === "GET" && req.url === "/v1/status?window=60m") {
      statusRequests += 1;
      respondJson(res, { state: "up", label: "正常" });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await listen(server);

  try {
    const env = {
      ...process.env,
      ANYROUTER_STATUS_STATE_DIR: stateDir,
      ANYROUTER_STATUS_CONFIG_URL: `http://127.0.0.1:${serverPort(server)}/config.json`,
      ANTHROPIC_BASE_URL: "https://anyrouter.top"
    };

    const first = await runStatusLine(env);
    const second = await runStatusLine(env);

    assert.match(first, /Any Router 近 60m 状态: 可用/);
    assert.match(second, /Any Router 近 60m 状态: 可用/);
    assert.equal(statusRequests, 1);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function runStatusLine(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [statuslinePath], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error("statusLine timed out"));
    }, 10000);

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun(Buffer.concat(chunks).toString("utf8"));
      else rejectRun(new Error(`statusLine exited with code ${code}: ${Buffer.concat(errors).toString("utf8")}`));
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
