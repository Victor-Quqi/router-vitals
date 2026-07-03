import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  MARKETPLACE_NAME,
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_FULL_ID,
  PLUGIN_ID,
  STATUSLINE_LAUNCHER_FILE_NAME
} from "../shared/site-config.mjs";

const setupPath = resolve("plugin/scripts/setup-statusline.mjs");

test("setup writes a stable launcher and statusLine setting", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "router-vitals-setup-"));

  try {
    await runNode([setupPath], { ROUTER_VITALS_CLAUDE_HOME: claudeHome });

    const launcherPath = join(claudeHome, STATUSLINE_LAUNCHER_FILE_NAME);
    const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));

    assert.equal(settings.statusLine.type, "command");
    assert.equal(settings.statusLine.command, `node ${JSON.stringify(launcherPath)}`);
    assert.match(await readFile(launcherPath, "utf8"), new RegExp(escapeRegExp(PLUGIN_FULL_ID)));
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("stable launcher runs the latest installed plugin statusLine", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "router-vitals-launcher-"));
  const oldPlugin = join(claudeHome, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_ID, "0.1.0");
  const newPlugin = join(claudeHome, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_ID, "0.2.0");

  try {
    await writeFakeStatusline(oldPlugin, "old");
    await writeFakeStatusline(newPlugin, "new");
    await writeInstalledPlugins(claudeHome, [
      {
        scope: "user",
        installPath: oldPlugin,
        version: "0.1.0",
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:00.000Z"
      },
      {
        scope: "user",
        installPath: newPlugin,
        version: "0.2.0",
        installedAt: "2026-01-02T00:00:00.000Z",
        lastUpdated: "2026-01-02T00:00:00.000Z"
      }
    ]);

    await runNode([setupPath], { ROUTER_VITALS_CLAUDE_HOME: claudeHome });

    const output = await runNode([join(claudeHome, STATUSLINE_LAUNCHER_FILE_NAME)], {
      ROUTER_VITALS_CLAUDE_HOME: claudeHome
    });
    assert.equal(output.trim(), "new");
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("stable launcher passes plugin data to statusLine", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "router-vitals-launcher-data-"));
  const pluginRoot = join(claudeHome, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_ID, "0.1.0");
  const expectedDataDir = join(claudeHome, "plugins", "data", PLUGIN_DATA_DIR_NAME);

  try {
    await writeFakeStatuslineSource(pluginRoot, "console.log(process.env.CLAUDE_PLUGIN_DATA || '');\n");
    await writeInstalledPlugins(claudeHome, [
      {
        scope: "user",
        installPath: pluginRoot,
        version: "0.1.0",
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:00.000Z"
      }
    ]);

    await runNode([setupPath], { ROUTER_VITALS_CLAUDE_HOME: claudeHome });

    const output = await runNode([join(claudeHome, STATUSLINE_LAUNCHER_FILE_NAME)], {
      ROUTER_VITALS_CLAUDE_HOME: claudeHome,
      CLAUDE_PLUGIN_DATA: undefined
    });

    assert.equal(output.trim(), expectedDataDir);
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("setup does not overwrite an unrelated statusLine unless forced", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "router-vitals-existing-statusline-"));
  const settingsPath = join(claudeHome, "settings.json");

  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      statusLine: {
        command: "node custom-statusline.mjs",
        type: "command"
      }
    }, null, 2), "utf8");

    const skippedOutput = await runNode([setupPath], { ROUTER_VITALS_CLAUDE_HOME: claudeHome });

    const unchanged = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(unchanged.statusLine.command, "node custom-statusline.mjs");
    assert.match(skippedOutput, /Claude Code 当前只支持一个 statusLine 命令/);
    assert.match(skippedOutput, /wrapper/);
    assert.match(skippedOutput, /--force/);

    await runNode([setupPath, "--force"], { ROUTER_VITALS_CLAUDE_HOME: claudeHome });

    const updated = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.match(updated.statusLine.command, new RegExp(escapeRegExp(STATUSLINE_LAUNCHER_FILE_NAME)));
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
});

async function writeFakeStatusline(pluginRoot: string, output: string): Promise<void> {
  await writeFakeStatuslineSource(pluginRoot, `console.log(${JSON.stringify(output)});\n`);
}

async function writeFakeStatuslineSource(pluginRoot: string, source: string): Promise<void> {
  const statuslinePath = join(pluginRoot, "scripts", "statusline.mjs");
  await mkdir(dirname(statuslinePath), { recursive: true });
  await writeFile(statuslinePath, `#!/usr/bin/env node\n${source}`, "utf8");
}

async function writeInstalledPlugins(claudeHome: string, installs: Array<Record<string, unknown>>): Promise<void> {
  const path = join(claudeHome, "plugins", "installed_plugins.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 2,
    plugins: {
      [PLUGIN_FULL_ID]: installs
    }
  }, null, 2), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      env: mergeEnv(process.env, env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`node timed out: ${args.join(" ")}`));
    }, 10000);

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun(Buffer.concat(chunks).toString("utf8"));
      else rejectRun(new Error(`node exited with code ${code}: ${Buffer.concat(errors).toString("utf8")}`));
    });
  });
}

function mergeEnv(base: NodeJS.ProcessEnv, override: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
