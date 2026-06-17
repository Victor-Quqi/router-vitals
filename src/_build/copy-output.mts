import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = process.cwd();
const outRoot = join(repoRoot, ".tsbuild", "out");
const excludedTopLevel = new Set(["_build"]);

await copyChildren(outRoot, repoRoot, 0);
await packagePluginPolicyCore();

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
  const pluginPolicyCorePath = join(repoRoot, "plugin", "scripts", "lib", "policy-core.mjs");
  const pluginPolicyPath = join(repoRoot, "plugin", "scripts", "lib", "policy.mjs");

  await cp(sharedPolicyCorePath, pluginPolicyCorePath);

  const policyContent = await readFile(pluginPolicyPath, "utf8");
  const packagedPolicyContent = policyContent.replace(
    `export * from "../../../shared/policy-core.mjs";`,
    `export * from "./policy-core.mjs";`
  );
  await writeFile(pluginPolicyPath, packagedPolicyContent, "utf8");
}
