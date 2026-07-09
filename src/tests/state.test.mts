import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getStateLockPath, getStatePath, loadState, withLockedState } from "../plugin/scripts/lib/state.mjs";
import { TARGET_HOSTS, getTodayKey } from "../shared/policy.mjs";
import { PLUGIN_ID } from "../shared/site-config.mjs";

const primaryTargetHost = TARGET_HOSTS[0]!;

const ENV_KEYS = [
  "ROUTER_VITALS_STATE_DIR",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "CLAUDE_PLUGIN_DATA"
] as const;

test("state path uses Claude plugin data before shared user state", async () => {
  await withEnv({
    ROUTER_VITALS_STATE_DIR: undefined,
    XDG_STATE_HOME: "/tmp/router-vitals-state",
    LOCALAPPDATA: undefined,
    APPDATA: undefined,
    CLAUDE_PLUGIN_DATA: "/tmp/router-vitals-plugin-data"
  }, async () => {
    assert.equal(getStatePath(), join("/tmp/router-vitals-plugin-data", PLUGIN_ID, "state.json"));
  });
});

test("state path override wins over user and plugin data dirs", async () => {
  await withEnv({
    ROUTER_VITALS_STATE_DIR: "/tmp/router-vitals-override",
    XDG_STATE_HOME: "/tmp/router-vitals-state",
    LOCALAPPDATA: undefined,
    APPDATA: undefined,
    CLAUDE_PLUGIN_DATA: "/tmp/router-vitals-plugin-data"
  }, async () => {
    assert.equal(getStatePath(), join("/tmp/router-vitals-override", PLUGIN_ID, "state.json"));
  });
});

test("loadState reads Claude plugin data state", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-vitals-state-"));
  const userState = join(root, "user-state");
  const pluginData = join(root, "plugin-data");
  const pluginStatePath = join(pluginData, PLUGIN_ID, "state.json");

  await mkdir(dirname(pluginStatePath), { recursive: true });
  await writeFile(pluginStatePath, JSON.stringify({
    version: 2,
    contributions: { "2099-01-01": 3 }
  }), "utf8");

  try {
    await withEnv({
      ROUTER_VITALS_STATE_DIR: undefined,
      XDG_STATE_HOME: userState,
      LOCALAPPDATA: undefined,
      APPDATA: undefined,
      CLAUDE_PLUGIN_DATA: pluginData
    }, async () => {
      const state = await loadState();
      assert.equal(state.contributions["2099-01-01"], 3);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadState discards an older state schema", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-state-v1-"));
  const statePath = join(stateDir, PLUGIN_ID, "state.json");
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    version: 1,
    contributions: { "2099-01-01": 3 },
    pending: { old: { startedAtMs: Date.now(), targetMatched: true } }
  }), "utf8");

  try {
    await withEnv({ ROUTER_VITALS_STATE_DIR: stateDir }, async () => {
      const state = await loadState();
      assert.equal(state.version, 2);
      assert.deepEqual(state.contributions, {});
      assert.deepEqual(state.pending, {});
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("loadState prunes stale local counters and turn state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-state-"));
  const statePath = join(stateDir, PLUGIN_ID, "state.json");
  const today = getTodayKey();
  const freshMs = Date.now();
  const staleMs = freshMs - 8 * 24 * 60 * 60 * 1000;

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    version: 2,
    contributions: {
      "2000-01-01": 1,
      [today]: 2
    },
    pending: {
      fresh: {
        client: "claude-code",
        settlementId: "11111111-1111-4111-8111-111111111111",
        startedAtMs: freshMs,
        targetMatched: true,
        modelClass: "sonnet"
      },
      stale: {
        client: "codex",
        settlementId: "22222222-2222-4222-8222-222222222222",
        startedAtMs: staleMs,
        targetMatched: true,
        modelClass: "opus"
      }
    },
    sessions: {
      fresh: { updatedAtMs: freshMs, promptCount: 1, modelClass: "sonnet" },
      stale: { updatedAtMs: staleMs, promptCount: 2, modelClass: "opus" }
    },
    updateReminder: {
      latestPluginVersion: "9.9.9",
      remindedAtMs: freshMs
    },
    lastDecision: {
      at: new Date(freshMs).toISOString(),
      eventName: "Stop",
      kind: "post_failed",
      reason: "http_error",
      modelClass: "sonnet",
      targetHost: primaryTargetHost,
      postStatusCode: 503
    },
    lastPayload: {
      ok: true,
      errorType: "none",
      modelClass: "sonnet",
      latencyBucket: "lt_3s",
      timeBucket: 30000000,
      pluginVersion: "0.1.0",
      anonymousId: "anon_abcdefghijklmnop",
      sampleRate: 1,
      targetMatched: true,
      targetHost: primaryTargetHost
    }
  }), "utf8");

  try {
    await withEnv({
      ROUTER_VITALS_STATE_DIR: stateDir,
      XDG_STATE_HOME: undefined,
      LOCALAPPDATA: undefined,
      APPDATA: undefined,
      CLAUDE_PLUGIN_DATA: undefined
    }, async () => {
      const state = await loadState();
      assert.deepEqual(state.contributions, { [today]: 2 });
      assert.equal("fresh" in state.pending, true);
      assert.equal("stale" in state.pending, false);
      assert.equal("fresh" in state.sessions, true);
      assert.equal("stale" in state.sessions, false);
      assert.deepEqual(state.updateReminder, {
        latestPluginVersion: "9.9.9",
        remindedAtMs: freshMs
      });
      assert.deepEqual(state.lastDecision, {
        at: new Date(freshMs).toISOString(),
        eventName: "Stop",
        kind: "post_failed",
        reason: "http_error",
        modelClass: "sonnet",
        targetHost: primaryTargetHost,
        postStatusCode: 503
      });
      assert.equal(state.lastPayload, null);
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("withLockedState serializes concurrent state updates", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "router-vitals-state-lock-"));
  const today = getTodayKey();

  try {
    await withEnv({ ROUTER_VITALS_STATE_DIR: stateDir }, async () => {
      await Promise.all(Array.from({ length: 12 }, () => withLockedState(async (state) => {
        const count = state.contributions[today] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.contributions[today] = count + 1;
      })));

      const state = await loadState();
      assert.equal(state.contributions[today], 12);
      await writeFile(getStateLockPath(), "free", { flag: "wx" });
      await rm(getStateLockPath(), { force: true });
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function withEnv(values: Partial<Record<typeof ENV_KEYS[number], string | undefined>>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<typeof ENV_KEYS[number], string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
