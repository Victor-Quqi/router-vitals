import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const repoRoot = process.cwd();
const configPath = join(repoRoot, "site.config.json");
const config = validateSiteConfig(JSON.parse(await readFile(configPath, "utf8")));
await writeIfChanged(join(repoRoot, "src", "shared", "site-config.mts"), createSiteConfigSource(config));
await syncClaudeManifest(config);
await syncCodexManifest(config);
await syncClaudeMarketplace(config);
await syncCodexMarketplace(config);
await syncWrangler(join(repoRoot, "worker", "wrangler.toml"), config.cloudflare.workerName, config.cloudflare.d1Name);
await syncWrangler(join(repoRoot, "worker", "wrangler.preview.toml"), config.cloudflare.previewWorkerName, config.cloudflare.d1Name);
await syncStatusPageHtml(config);
console.log(`Synced site config for ${config.siteName}`);
function validateSiteConfig(value) {
    if (!isRecord(value))
        throw new Error("site.config.json must be an object");
    const config = value;
    assertString(config.siteName, "siteName");
    assertString(config.pluginId, "pluginId");
    assertString(config.defaultApiBaseUrl, "defaultApiBaseUrl");
    assertString(config.statusPageUrl, "statusPageUrl");
    if (!isRecord(config.marketplace))
        throw new Error("marketplace must be an object");
    assertString(config.marketplace.name, "marketplace.name");
    assertString(config.marketplace.owner, "marketplace.owner");
    assertString(config.marketplace.repoUrl, "marketplace.repoUrl");
    if (!Array.isArray(config.endpoints) || config.endpoints.length === 0)
        throw new Error("endpoints must be a non-empty array");
    for (const [index, endpoint] of config.endpoints.entries()) {
        if (!isRecord(endpoint))
            throw new Error(`endpoints[${index}] must be an object`);
        assertString(endpoint.id, `endpoints[${index}].id`);
        assertString(endpoint.host, `endpoints[${index}].host`);
        assertString(endpoint.label, `endpoints[${index}].label`);
    }
    if (!isRecord(config.cloudflare))
        throw new Error("cloudflare must be an object");
    assertString(config.cloudflare.workerName, "cloudflare.workerName");
    assertString(config.cloudflare.previewWorkerName, "cloudflare.previewWorkerName");
    assertString(config.cloudflare.d1Name, "cloudflare.d1Name");
    assertString(config.cloudflare.pagesProject, "cloudflare.pagesProject");
    return config;
}
function assertString(value, label) {
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`${label} must be a non-empty string`);
}
function createSiteConfigSource(config) {
    return `// Generated from site.config.json. Do not edit.

export const SITE_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)} as const);

export const SITE_NAME = SITE_CONFIG.siteName;
export const SITE_ENDPOINTS = SITE_CONFIG.endpoints;
export const PLUGIN_ID = SITE_CONFIG.pluginId;
export const MARKETPLACE_NAME = SITE_CONFIG.marketplace.name;
export const MARKETPLACE_OWNER = SITE_CONFIG.marketplace.owner;
export const MARKETPLACE_REPO_URL = SITE_CONFIG.marketplace.repoUrl;
export const PLUGIN_FULL_ID = \`\${PLUGIN_ID}@\${MARKETPLACE_NAME}\`;
export const PLUGIN_DATA_DIR_NAME = \`\${PLUGIN_ID}-\${MARKETPLACE_NAME}\`;
export const STATUSLINE_LAUNCHER_FILE_NAME = \`\${MARKETPLACE_NAME}-statusline.mjs\`;
`;
}
async function syncClaudeManifest(config) {
    const path = join(repoRoot, "plugin", ".claude-plugin", "plugin.json");
    const manifest = await readJson(path);
    manifest.name = config.pluginId;
    manifest.displayName = `${config.siteName} Status Monitor`;
    manifest.description = `Anonymous community status monitor for ${config.siteName} Claude Code and Codex usage.`;
    manifest.homepage = config.marketplace.repoUrl;
    manifest.repository = config.marketplace.repoUrl;
    manifest.keywords = ["claude-code", "codex", "status", siteKeyword(config)];
    await writeJson(path, manifest);
}
async function syncCodexManifest(config) {
    const path = join(repoRoot, "plugin", ".codex-plugin", "plugin.json");
    const manifest = await readJson(path);
    manifest.name = config.pluginId;
    manifest.displayName = `${config.siteName} Status Monitor`;
    manifest.description = `Anonymous community status monitor for ${config.siteName} Codex usage.`;
    manifest.homepage = config.marketplace.repoUrl;
    manifest.repository = config.marketplace.repoUrl;
    manifest.keywords = ["codex", "status", siteKeyword(config)];
    await writeJson(path, manifest);
}
async function syncClaudeMarketplace(config) {
    const path = join(repoRoot, ".claude-plugin", "marketplace.json");
    const marketplace = await readJson(path);
    marketplace.name = config.marketplace.name;
    marketplace.description = `Anonymous community status monitoring plugins for ${config.siteName}.`;
    marketplace.owner = { name: config.marketplace.owner };
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    const plugin = plugins.find(isRecord) ?? {};
    plugin.name = config.pluginId;
    plugin.source = "./plugin";
    plugin.displayName = `${config.siteName} Status Monitor`;
    plugin.description = `Anonymous Claude Code and Codex usage status reporter for ${config.siteName}.`;
    plugin.author = { name: config.marketplace.name };
    plugin.homepage = config.marketplace.repoUrl;
    plugin.repository = config.marketplace.repoUrl;
    plugin.category = plugin.category ?? "monitoring";
    plugin.tags = ["status", siteKeyword(config), "claude-code", "codex"];
    marketplace.plugins = [plugin];
    await writeJson(path, marketplace);
}
async function syncCodexMarketplace(config) {
    const path = join(repoRoot, ".agents", "plugins", "marketplace.json");
    const marketplace = await readJson(path);
    marketplace.name = config.marketplace.name;
    marketplace.interface = {
        ...(isRecord(marketplace.interface) ? marketplace.interface : {}),
        displayName: titleFromName(config.marketplace.name)
    };
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    const plugin = plugins.find(isRecord) ?? {};
    plugin.name = config.pluginId;
    plugin.source = { source: "local", path: "./plugin" };
    plugin.policy = isRecord(plugin.policy)
        ? plugin.policy
        : { installation: "AVAILABLE", authentication: "ON_INSTALL" };
    plugin.category = plugin.category ?? "Productivity";
    marketplace.owner = { name: config.marketplace.owner };
    marketplace.tags = ["status", siteKeyword(config), "codex"];
    marketplace.plugins = [plugin];
    await writeJson(path, marketplace);
}
async function syncWrangler(path, workerName, d1Name) {
    const current = await readFile(path, "utf8");
    let next = replaceRequired(current, /^name = ".*"$/m, `name = "${workerName}"`, `${path} worker name`);
    next = replaceRequired(next, /^database_name = ".*"$/m, `database_name = "${d1Name}"`, `${path} D1 database_name`);
    await writeIfChanged(path, next);
}
async function syncStatusPageHtml(config) {
    const path = join(repoRoot, "status-page", "index.html");
    const current = await readFile(path, "utf8");
    let next = replaceRequired(current, /<title data-site-sync="title">.*?<\/title>/, `<title data-site-sync="title">${escapeHtml(config.siteName)} 状态</title>`, "status page title");
    next = replaceRequired(next, /<h1 id="siteTitle">.*?<\/h1>/, `<h1 id="siteTitle">${escapeHtml(config.siteName)} 状态</h1>`, "status page h1");
    next = replaceRequired(next, /<p id="siteSubtitle">.*?<\/p>/, `<p id="siteSubtitle">Claude Code / Codex 社区轮次观测</p>`, "status page subtitle");
    next = replaceRequired(next, /const key = "[^"]+-theme";/, `const key = "${escapeJsString(config.marketplace.name)}-theme";`, "status page theme key");
    next = replaceAnchorHref(next, "github", config.marketplace.repoUrl);
    next = replaceAnchorHref(next, "install-link", config.marketplace.repoUrl);
    await writeIfChanged(path, next);
}
function replaceAnchorHref(source, marker, href) {
    const pattern = new RegExp(`(<a\\b(?=[^>]*data-site-sync="${marker}")[^>]*\\bhref=")[^"]*(")`);
    if (!pattern.test(source))
        throw new Error(`status page ${marker} link marker not found`);
    return source.replace(pattern, `$1${escapeHtml(href)}$2`);
}
function replaceRequired(source, pattern, replacement, label) {
    if (!pattern.test(source))
        throw new Error(`${label} marker not found`);
    return source.replace(pattern, replacement);
}
async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}
async function writeJson(path, value) {
    await writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function writeIfChanged(path, next) {
    let current = "";
    try {
        current = await readFile(path, "utf8");
    }
    catch {
        current = "";
    }
    if (current !== next)
        await writeFile(path, next, "utf8");
}
function titleFromName(name) {
    return name
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ");
}
function siteKeyword(config) {
    return config.siteName.toLowerCase().replace(/[^a-z0-9]+/g, "") || config.marketplace.name;
}
function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeJsString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
