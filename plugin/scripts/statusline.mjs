#!/usr/bin/env node
import { loadRemoteConfig } from "./lib/config.mjs";
import { matchTargetBaseUrl } from "./lib/policy.mjs";
import { getTodayContributions, loadState } from "./lib/state.mjs";
main().catch(() => {
    console.log("Any Router 近 60m 状态: 状态暂缺");
});
async function main() {
    const [state, config] = await Promise.all([loadState(), loadRemoteConfig()]);
    const target = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
    const count = getTodayContributions(state);
    if (!target.matched) {
        console.log(`Any Router 近 60m 状态: 未匹配目标站 · 贡献暂停 · 今日贡献 ${count} 条`);
        return;
    }
    const status = await fetchStatus(config.apiBaseUrl);
    const statusText = formatStatus(status);
    const contributionText = config.reportingEnabled === false ? "贡献暂停" : "贡献开启";
    console.log(`Any Router 近 60m 状态: ${statusText} · ${contributionText} · 今日贡献 ${count} 条`);
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
