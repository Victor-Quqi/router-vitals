import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const setupPath = resolve("plugin/scripts/setup-statusline.mjs");
const pluginId = "anyrouter-status-monitor@router-vitals";
test("setup writes a stable launcher and statusLine setting", async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), "router-vitals-setup-"));
    try {
        await runNode([setupPath], { ANYROUTER_STATUS_CLAUDE_HOME: claudeHome });
        const launcherPath = join(claudeHome, "router-vitals-statusline.mjs");
        const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
        assert.equal(settings.statusLine.type, "command");
        assert.equal(settings.statusLine.command, `node ${JSON.stringify(launcherPath)}`);
        assert.match(await readFile(launcherPath, "utf8"), /anyrouter-status-monitor@router-vitals/);
    }
    finally {
        await rm(claudeHome, { recursive: true, force: true });
    }
});
test("stable launcher runs the latest installed plugin statusLine", async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), "router-vitals-launcher-"));
    const oldPlugin = join(claudeHome, "plugins", "cache", "router-vitals", "anyrouter-status-monitor", "0.1.0");
    const newPlugin = join(claudeHome, "plugins", "cache", "router-vitals", "anyrouter-status-monitor", "0.2.0");
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
        await runNode([setupPath], { ANYROUTER_STATUS_CLAUDE_HOME: claudeHome });
        const output = await runNode([join(claudeHome, "router-vitals-statusline.mjs")], {
            ANYROUTER_STATUS_CLAUDE_HOME: claudeHome
        });
        assert.equal(output.trim(), "new");
    }
    finally {
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
        await runNode([setupPath], { ANYROUTER_STATUS_CLAUDE_HOME: claudeHome });
        const unchanged = JSON.parse(await readFile(settingsPath, "utf8"));
        assert.equal(unchanged.statusLine.command, "node custom-statusline.mjs");
        await runNode([setupPath, "--force"], { ANYROUTER_STATUS_CLAUDE_HOME: claudeHome });
        const updated = JSON.parse(await readFile(settingsPath, "utf8"));
        assert.match(updated.statusLine.command, /router-vitals-statusline\.mjs/);
    }
    finally {
        await rm(claudeHome, { recursive: true, force: true });
    }
});
async function writeFakeStatusline(pluginRoot, output) {
    const statuslinePath = join(pluginRoot, "scripts", "statusline.mjs");
    await mkdir(dirname(statuslinePath), { recursive: true });
    await writeFile(statuslinePath, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(output)});\n`, "utf8");
}
async function writeInstalledPlugins(claudeHome, installs) {
    const path = join(claudeHome, "plugins", "installed_plugins.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
        version: 2,
        plugins: {
            [pluginId]: installs
        }
    }, null, 2), "utf8");
}
function runNode(args, env) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, args, {
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"]
        });
        const chunks = [];
        const errors = [];
        const timeout = setTimeout(() => {
            child.kill();
            rejectRun(new Error(`node timed out: ${args.join(" ")}`));
        }, 10000);
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => errors.push(chunk));
        child.on("error", rejectRun);
        child.on("exit", (code) => {
            clearTimeout(timeout);
            if (code === 0)
                resolveRun(Buffer.concat(chunks).toString("utf8"));
            else
                rejectRun(new Error(`node exited with code ${code}: ${Buffer.concat(errors).toString("utf8")}`));
        });
    });
}
