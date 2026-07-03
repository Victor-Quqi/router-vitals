import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Mode = "check" | "sync";

const mode = parseMode(process.argv[2]);
const repoRoot = process.cwd();
const pluginManifestPath = join(repoRoot, "plugin", ".claude-plugin", "plugin.json");
const codexManifestPath = join(repoRoot, "plugin", ".codex-plugin", "plugin.json");
const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
const policyPaths = [
  join(repoRoot, "src", "shared", "policy-core.mts"),
  join(repoRoot, "shared", "policy-core.mjs"),
  join(repoRoot, "plugin", "scripts", "lib", "policy-core.mjs")
];

const pluginManifest = await readJson(pluginManifestPath);
const version = readVersion(pluginManifest, "plugin manifest");
const mismatches: string[] = [];

for (const path of policyPaths) await checkPolicyVersion(path, version, mismatches);
await checkMarketplaceVersion(version, mismatches);
await checkCodexManifestVersion(version, mismatches);

if (mode === "sync") {
  for (const path of policyPaths) await syncPolicyVersion(path, version);
  await syncMarketplaceVersion(version);
  await syncCodexManifestVersion(version);
  console.log(`Synced plugin version ${version}`);
} else if (mismatches.length > 0) {
  console.error(mismatches.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Plugin version ${version} is consistent`);
}

function parseMode(value: string | undefined): Mode {
  if (value === "sync" || value === "check") return value;
  return "check";
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function readVersion(value: Record<string, unknown>, label: string): string {
  if (typeof value.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)) {
    return value.version;
  }
  throw new Error(`${label} has no valid version`);
}

async function checkPolicyVersion(path: string, version: string, mismatches: string[]): Promise<void> {
  const content = await readFile(path, "utf8");
  const actual = content.match(/export const PLUGIN_VERSION = "([^"]+)";/)?.[1];
  if (actual !== version) mismatches.push(`${path}: PLUGIN_VERSION is ${actual ?? "<missing>"}, expected ${version}`);
}

async function syncPolicyVersion(path: string, version: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const pattern = /export const PLUGIN_VERSION = "[^"]+";/;
  if (!pattern.test(content)) throw new Error(`${path}: PLUGIN_VERSION not found`);
  const next = content.replace(pattern, `export const PLUGIN_VERSION = "${version}";`);
  if (next !== content) await writeFile(path, next, "utf8");
}

async function checkMarketplaceVersion(version: string, mismatches: string[]): Promise<void> {
  const marketplace = await readJson(marketplacePath);
  if (marketplace.version !== version) {
    mismatches.push(`${marketplacePath}: version is ${String(marketplace.version)}, expected ${version}`);
  }

  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const plugin = plugins.find((item) => isRecord(item) && item.name === "anyrouter-status-monitor");
  const pluginVersion = isRecord(plugin) ? plugin.version : undefined;
  if (pluginVersion !== version) {
    mismatches.push(`${marketplacePath}: anyrouter-status-monitor version is ${String(pluginVersion)}, expected ${version}`);
  }
}

async function syncMarketplaceVersion(version: string): Promise<void> {
  const marketplace = await readJson(marketplacePath);
  marketplace.version = version;
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  for (const item of plugins) {
    if (isRecord(item) && item.name === "anyrouter-status-monitor") item.version = version;
  }
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
}

async function checkCodexManifestVersion(version: string, mismatches: string[]): Promise<void> {
  const manifest = await readJson(codexManifestPath);
  if (manifest.version !== version) {
    mismatches.push(`${codexManifestPath}: version is ${String(manifest.version)}, expected ${version}`);
  }
}

async function syncCodexManifestVersion(version: string): Promise<void> {
  const manifest = await readJson(codexManifestPath);
  manifest.version = version;
  await writeFile(codexManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
