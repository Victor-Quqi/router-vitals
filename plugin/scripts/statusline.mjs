#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRemoteConfig } from "./lib/config.mjs";
import { LOCAL_DAILY_REPORT_LIMIT, PLUGIN_VERSION, matchTargetBaseUrl } from "./lib/policy.mjs";
import { getTodayContributions, loadState, loadStatusCache, saveStatusCache } from "./lib/state.mjs";
const STATUS_CACHE_TTL_MS = 60 * 1000;
const MARKETPLACE_NAME = "router-vitals";
const PLUGIN_NAME = "anyrouter-status-monitor";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
main().catch(() => {
    console.log("Any Router 近 60m 状态: 状态暂缺");
});
async function main() {
    const [state, config] = await Promise.all([loadState(), loadRemoteConfig()]);
    const target = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
    const count = getTodayContributions(state);
    const updateHint = await formatUpdateHint(config.latestPluginVersion);
    const suffix = updateHint ? ` · ${updateHint}` : "";
    if (!target.matched) {
        console.log(`Any Router 近 60m 状态: 未匹配目标站 · 贡献暂停 · ${formatContributionCount(count)}${suffix}`);
        return;
    }
    const status = await getCachedStatus(config.apiBaseUrl);
    const statusText = formatStatus(status);
    const contributionText = config.reportingEnabled === false ? "贡献暂停" : "贡献开启";
    console.log(`Any Router 近 60m 状态: ${statusText} · ${contributionText} · ${formatContributionCount(count)}${suffix}`);
}
async function getCachedStatus(apiBaseUrl) {
    const nowMs = Date.now();
    const cached = await loadStatusCache();
    if (cached?.apiBaseUrl === apiBaseUrl && cached.fetchedAtMs + STATUS_CACHE_TTL_MS > nowMs) {
        return cached.status;
    }
    const status = await fetchStatus(apiBaseUrl);
    await saveStatusCache({
        apiBaseUrl,
        fetchedAtMs: nowMs,
        status: status ? { ...status } : null
    });
    return status;
}
async function fetchStatus(apiBaseUrl) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/v1/status?window=60m`, {
            signal: controller.signal,
            headers: { accept: "application/json" }
        });
        clearTimeout(timeout);
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch {
        return null;
    }
}
function formatStatus(status) {
    if (!status || status.state === "insufficient_data")
        return "观测中";
    if (status.state === "down")
        return "不可用";
    if (status.state === "unstable")
        return status.label || "失败偏高";
    return "可用";
}
function formatContributionCount(count) {
    if (count >= LOCAL_DAILY_REPORT_LIMIT)
        return `今日贡献 ${count}/${LOCAL_DAILY_REPORT_LIMIT} 条 · 今日已满`;
    return `今日贡献 ${count} 条`;
}
async function formatUpdateHint(latestPluginVersion) {
    if (comparePluginVersions(latestPluginVersion, PLUGIN_VERSION) <= 0)
        return null;
    const globalAutoUpdaterDisabled = isTruthyEnv(process.env.DISABLE_AUTOUPDATER);
    const pluginAutoUpdaterForced = isTruthyEnv(process.env.FORCE_AUTOUPDATE_PLUGINS);
    const installationChecksDisabled = isTruthyEnv(process.env.DISABLE_INSTALLATION_CHECKS);
    const updateState = await loadClaudePluginUpdateState(latestPluginVersion);
    if (updateState.latestVersionCached && comparePluginVersions(latestPluginVersion, updateState.installedVersion || PLUGIN_VERSION) > 0) {
        const activeVersion = updateState.installedVersion || PLUGIN_VERSION;
        const installChecksNote = installationChecksDisabled ? " · DISABLE_INSTALLATION_CHECKS 可能阻止切换" : "";
        return `插件更新失败: 已下载 ${latestPluginVersion}，仍运行 ${activeVersion}${installChecksNote}`;
    }
    if (updateState.marketplaceAutoUpdate === false) {
        return `插件更新失败: Marketplace auto-update 未开启`;
    }
    if (globalAutoUpdaterDisabled && !pluginAutoUpdaterForced) {
        const installChecksNote = installationChecksDisabled ? "；DISABLE_INSTALLATION_CHECKS 也可能阻止更新" : "";
        return `插件更新失败: DISABLE_AUTOUPDATER 阻止更新${installChecksNote}`;
    }
    if (installationChecksDisabled) {
        return `插件更新失败: DISABLE_INSTALLATION_CHECKS 已开启`;
    }
    return `插件有新版 ${latestPluginVersion} · 自动更新未完成`;
}
async function loadClaudePluginUpdateState(latestPluginVersion) {
    const claudeHome = process.env.ANYROUTER_STATUS_CLAUDE_HOME || join(homedir(), ".claude");
    const [marketplaceAutoUpdate, installedVersion, latestVersionCached] = await Promise.all([
        readMarketplaceAutoUpdate(claudeHome),
        readInstalledPluginVersion(claudeHome),
        pathExists(join(claudeHome, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, latestPluginVersion))
    ]);
    return {
        marketplaceAutoUpdate,
        installedVersion,
        latestVersionCached
    };
}
async function readMarketplaceAutoUpdate(claudeHome) {
    try {
        const raw = await readFile(join(claudeHome, "plugins", "known_marketplaces.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed))
            return null;
        const marketplace = parsed[MARKETPLACE_NAME];
        if (!isRecord(marketplace) || typeof marketplace.autoUpdate !== "boolean")
            return null;
        return marketplace.autoUpdate;
    }
    catch {
        return null;
    }
}
async function readInstalledPluginVersion(claudeHome) {
    try {
        const raw = await readFile(join(claudeHome, "plugins", "installed_plugins.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed) || !isRecord(parsed.plugins))
            return null;
        const installs = parsed.plugins[PLUGIN_ID];
        if (!Array.isArray(installs))
            return null;
        const versions = installs
            .filter(isRecord)
            .map((install) => install.version)
            .filter((version) => typeof version === "string" && parsePluginVersion(version) !== null)
            .sort(comparePluginVersions)
            .reverse();
        return versions[0] || null;
    }
    catch {
        return null;
    }
}
async function pathExists(path) {
    try {
        await access(path, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
function isTruthyEnv(value) {
    return /^(1|true|yes|on)$/i.test(value ?? "");
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function comparePluginVersions(left, right) {
    const leftParts = parsePluginVersion(left);
    const rightParts = parsePluginVersion(right);
    if (!leftParts || !rightParts)
        return 0;
    for (let index = 0; index < leftParts.length; index += 1) {
        const diff = leftParts[index] - rightParts[index];
        if (diff !== 0)
            return diff;
    }
    return 0;
}
function parsePluginVersion(value) {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
