import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = process.cwd();
const outRoot = join(repoRoot, ".tsbuild", "out");
const excludedTopLevel = new Set(["_build", "tests"]);

await copyChildren(outRoot, repoRoot, 0);
await packagePluginPolicyCore();
await packageStatusPageSiteConfig();

async function copyChildren(fromDir: string, toDir: string, depth: number): Promise<void> {
  await mkdir(toDir, { recursive: true });
  const entries = await readdir(fromDir, { withFileTypes: true });

  for (const entry of entries) {
    if (depth === 0 && excludedTopLevel.has(entry.name)) continue;

    const fromPath = join(fromDir, entry.name);
    const toPath = join(toDir, entry.name);

    if (entry.isDirectory()) {
      await copyChildren(fromPath, toPath, depth + 1);
      continue;
    }

    if (entry.isFile()) await cp(fromPath, toPath);
  }
}

async function packagePluginPolicyCore(): Promise<void> {
  const sharedPolicyCorePath = join(repoRoot, "shared", "policy-core.mjs");
  const sharedSiteConfigPath = join(repoRoot, "shared", "site-config.mjs");
  const pluginPolicyCorePath = join(repoRoot, "plugin", "scripts", "lib", "policy-core.mjs");
  const pluginSiteConfigPath = join(repoRoot, "plugin", "scripts", "lib", "site-config.mjs");

  await cp(sharedPolicyCorePath, pluginPolicyCorePath);
  await cp(sharedSiteConfigPath, pluginSiteConfigPath);
}

async function packageStatusPageSiteConfig(): Promise<void> {
  const sharedSiteConfigPath = join(repoRoot, "shared", "site-config.mjs");
  const statusPageSharedDir = join(repoRoot, "status-page", "shared");
  const statusPageSiteConfigPath = join(statusPageSharedDir, "site-config.mjs");

  await mkdir(statusPageSharedDir, { recursive: true });
  await cp(sharedSiteConfigPath, statusPageSiteConfigPath);
}
