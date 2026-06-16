#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "anyrouter-status-monitor@router-vitals";
const LAUNCHER_FILE_NAME = "router-vitals-statusline.mjs";

interface SetupOptions {
  force: boolean;
}

interface ClaudeSettings {
  statusLine?: unknown;
  [key: string]: unknown;
}

main().catch((error) => {
  console.error(`statusLine 设置失败: ${getErrorMessage(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const claudeHome = getClaudeHome();
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const launcherPath = join(claudeHome, LAUNCHER_FILE_NAME);
  const settingsPath = join(claudeHome, "settings.json");
  const statusLine = {
    command: `node ${JSON.stringify(launcherPath)}`,
    type: "command"
  };

  await mkdir(claudeHome, { recursive: true });
  await writeTextFileAtomic(launcherPath, createLauncherSource(pluginRoot));

  const settings = await loadSettings(settingsPath);
  if (hasUnrelatedStatusLine(settings.statusLine) && !options.force) {
    console.log(`已写入稳定入口: ${launcherPath}`);
    console.log("检测到已有 statusLine，未覆盖。确认要替换时重新运行并加上 --force。");
    return;
  }

  settings.statusLine = statusLine;
  await writeJsonFileAtomic(settingsPath, settings);

  console.log(`已写入稳定入口: ${launcherPath}`);
  console.log(`已更新 Claude Code statusLine: ${settingsPath}`);
}

function parseOptions(args: string[]): SetupOptions {
  return { force: args.includes("--force") };
}

function getClaudeHome(): string {
  return process.env.ANYROUTER_STATUS_CLAUDE_HOME || join(homedir(), ".claude");
}

async function loadSettings(path: string): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

function hasUnrelatedStatusLine(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const command = value.command;
  if (typeof command !== "string" || command.trim() === "") return false;
  return !isRouterVitalsStatusLineCommand(command);
}

function isRouterVitalsStatusLineCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes(LAUNCHER_FILE_NAME) ||
    (normalized.includes("anyrouter-status-monitor") && normalized.includes("statusline.mjs")) ||
    (normalized.includes("router-vitals") && normalized.includes("plugin/scripts/statusline.mjs"))
  );
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFileAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, value, "utf8");
  await rename(tmpPath, path);
}

function createLauncherSource(fallbackInstallPath: string): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = ${JSON.stringify(PLUGIN_ID)};
const FALLBACK_INSTALL_PATH = ${JSON.stringify(fallbackInstallPath)};

main().catch(() => {
  console.log("Any Router 近 60m 状态: 状态暂缺");
});

async function main() {
  const statuslinePath = await resolveStatuslinePath();
  await runStatusline(statuslinePath);
}

async function resolveStatuslinePath() {
  const installPaths = await readInstalledPluginPaths();
  if (typeof FALLBACK_INSTALL_PATH === "string" && FALLBACK_INSTALL_PATH.length > 0) {
    installPaths.push(FALLBACK_INSTALL_PATH);
  }

  for (const installPath of dedupe(installPaths)) {
    const statuslinePath = join(installPath, "scripts", "statusline.mjs");
    if (await fileExists(statuslinePath)) return statuslinePath;
  }

  throw new Error("statusline script not found");
}

async function readInstalledPluginPaths() {
  const installedPluginsPath = join(getClaudeHome(), "plugins", "installed_plugins.json");
  try {
    const raw = await readFile(installedPluginsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) return [];
    const installs = parsed.plugins[PLUGIN_ID];
    if (!Array.isArray(installs)) return [];
    return installs
      .filter(isRecord)
      .filter((item) => typeof item.installPath === "string" && item.installPath.length > 0)
      .sort(compareInstalls)
      .map((item) => item.installPath);
  } catch {
    return [];
  }
}

function compareInstalls(a, b) {
  const userDelta = scopeRank(b) - scopeRank(a);
  if (userDelta !== 0) return userDelta;
  return getInstallTime(b) - getInstallTime(a);
}

function scopeRank(value) {
  return value.scope === "user" ? 1 : 0;
}

function getInstallTime(value) {
  for (const key of ["lastUpdated", "installedAt"]) {
    const timestamp = typeof value[key] === "string" ? Date.parse(value[key]) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function runStatusline(statuslinePath) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [statuslinePath], {
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (signal) process.exitCode = 1;
      else if (typeof code === "number") process.exitCode = code;
      resolveRun();
    });
  });
}

async function fileExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getClaudeHome() {
  return process.env.ANYROUTER_STATUS_CLAUDE_HOME || join(homedir(), ".claude");
}

function dedupe(values) {
  return Array.from(new Set(values));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
