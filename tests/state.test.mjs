import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getStatePath, loadState } from "../plugin/scripts/lib/state.mjs";
const ENV_KEYS = [
    "ANYROUTER_STATUS_STATE_DIR",
    "XDG_STATE_HOME",
    "LOCALAPPDATA",
    "APPDATA",
    "CLAUDE_PLUGIN_DATA"
];
test("state path uses shared user state before Claude plugin data", async () => {
    await withEnv({
        ANYROUTER_STATUS_STATE_DIR: undefined,
        XDG_STATE_HOME: "/tmp/router-vitals-state",
        LOCALAPPDATA: undefined,
        APPDATA: undefined,
        CLAUDE_PLUGIN_DATA: "/tmp/router-vitals-plugin-data"
    }, async () => {
        assert.equal(getStatePath(), join("/tmp/router-vitals-state", "anyrouter-status-monitor", "state.json"));
    });
});
test("state path override wins over user and plugin data dirs", async () => {
    await withEnv({
        ANYROUTER_STATUS_STATE_DIR: "/tmp/router-vitals-override",
        XDG_STATE_HOME: "/tmp/router-vitals-state",
        LOCALAPPDATA: undefined,
        APPDATA: undefined,
        CLAUDE_PLUGIN_DATA: "/tmp/router-vitals-plugin-data"
    }, async () => {
        assert.equal(getStatePath(), join("/tmp/router-vitals-override", "anyrouter-status-monitor", "state.json"));
    });
});
test("loadState can read legacy Claude plugin data state", async () => {
    const root = await mkdtemp(join(tmpdir(), "router-vitals-state-"));
    const userState = join(root, "user-state");
    const pluginData = join(root, "plugin-data");
    const legacyPath = join(pluginData, "anyrouter-status-monitor", "state.json");
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({
        version: 1,
        contributions: { "2099-01-01": 3 }
    }), "utf8");
    try {
        await withEnv({
            ANYROUTER_STATUS_STATE_DIR: undefined,
            XDG_STATE_HOME: userState,
            LOCALAPPDATA: undefined,
            APPDATA: undefined,
            CLAUDE_PLUGIN_DATA: pluginData
        }, async () => {
            const state = await loadState();
            assert.equal(state.contributions["2099-01-01"], 3);
        });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
async function withEnv(values, run) {
    const previous = new Map();
    for (const key of ENV_KEYS) {
        previous.set(key, process.env[key]);
        const value = values[key];
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
    try {
        await run();
    }
    finally {
        for (const key of ENV_KEYS) {
            const value = previous.get(key);
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
}
