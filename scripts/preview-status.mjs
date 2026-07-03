import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
const wranglerConfig = "worker/wrangler.preview.toml";
const siteConfig = JSON.parse(await readFile("site.config.json", "utf8"));
const d1Name = readD1Name(siteConfig);
const port = process.env.STATUS_PREVIEW_PORT || "8788";
if (!/^\d+$/.test(port))
    throw new Error("STATUS_PREVIEW_PORT must be a numeric port");
const pnpm = "pnpm";
const wranglerDlxArgs = ["dlx", "--allow-build=esbuild,sharp,workerd", "wrangler@4"];
const wranglerEnv = buildWranglerEnv();
const seedPreviewData = process.env.STATUS_PREVIEW_SEED !== "0";
if (seedPreviewData) {
    await runWrangler(["d1", "execute", d1Name, "--local", "--config", wranglerConfig, "--file", "worker/preview/reset.sql"]);
    for (const migration of await listMigrationFiles()) {
        await runWrangler(["d1", "execute", d1Name, "--local", "--config", wranglerConfig, "--file", migration]);
    }
    await runWrangler(["d1", "execute", d1Name, "--local", "--config", wranglerConfig, "--file", "worker/preview/seed.sql"]);
}
else {
    await runWrangler(["d1", "migrations", "apply", d1Name, "--local", "--config", wranglerConfig]);
}
const dev = spawnPnpm([
    ...wranglerDlxArgs,
    "dev",
    "--config",
    wranglerConfig,
    "--local",
    "--port",
    port
]);
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        dev.kill(signal);
    });
}
dev.on("exit", (code, signal) => {
    if (signal)
        process.kill(process.pid, signal);
    process.exit(code ?? 0);
});
function runWrangler(args) {
    return new Promise((resolve, reject) => {
        const child = spawnPnpm([...wranglerDlxArgs, ...args]);
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`wrangler ${args.join(" ")} exited with code ${code ?? "unknown"}`));
        });
    });
}
function spawnPnpm(args) {
    if (process.platform === "win32") {
        return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [pnpm, ...args].map(quoteCmdArg).join(" ")], {
            env: wranglerEnv,
            stdio: "inherit",
            shell: false
        });
    }
    return spawn(pnpm, args, {
        env: wranglerEnv,
        stdio: "inherit",
        shell: false
    });
}
function quoteCmdArg(value) {
    if (!/[\s"&|<>^]/.test(value))
        return value;
    return `"${value.replace(/"/g, '\\"')}"`;
}
function buildWranglerEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("="))
            env[key] = value;
    }
    env.XDG_CONFIG_HOME = resolve(".wrangler", "config");
    return env;
}
async function listMigrationFiles() {
    const migrationDir = "worker/migrations";
    const names = await readdir(migrationDir);
    return names
        .filter((name) => name.endsWith(".sql"))
        .sort((left, right) => left.localeCompare(right))
        .map((name) => join(migrationDir, name).replace(/\\/g, "/"));
}
function readD1Name(config) {
    const d1Name = config.cloudflare?.d1Name;
    if (typeof d1Name !== "string" || d1Name.trim() === "")
        throw new Error("site.config.json cloudflare.d1Name must be a non-empty string");
    return d1Name;
}
