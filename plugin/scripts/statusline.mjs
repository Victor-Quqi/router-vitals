#!/usr/bin/env node
import { loadRemoteConfig } from "./lib/config.mjs";
import { LOCAL_DAILY_REPORT_LIMIT, PLUGIN_VERSION, matchTargetBaseUrl } from "./lib/policy.mjs";
import { getTodayContributions, loadState, loadStatusCache, saveStatusCache } from "./lib/state.mjs";
const STATUS_CACHE_TTL_MS = 60 * 1000;
main().catch(() => {
    console.log("Any Router 近 60m 状态: 状态暂缺");
});
async function main() {
    const [state, config] = await Promise.all([loadState(), loadRemoteConfig()]);
    const target = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
    const count = getTodayContributions(state);
    const updateHint = formatUpdateHint(config.latestPluginVersion);
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
function formatUpdateHint(latestPluginVersion) {
    if (comparePluginVersions(latestPluginVersion, PLUGIN_VERSION) <= 0)
        return null;
    return `插件有新版 ${latestPluginVersion} · 手动更新`;
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
