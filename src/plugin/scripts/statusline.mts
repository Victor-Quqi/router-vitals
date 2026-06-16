#!/usr/bin/env node
import { loadRemoteConfig } from "./lib/config.mjs";
import { LOCAL_DAILY_REPORT_LIMIT, matchTargetBaseUrl } from "./lib/policy.mjs";
import { getTodayContributions, loadState, loadStatusCache, saveStatusCache } from "./lib/state.mjs";

const STATUS_CACHE_TTL_MS = 60 * 1000;

interface StatusSummary {
  state?: string;
  label?: string;
}

main().catch(() => {
  console.log("Any Router 近 60m 状态: 状态暂缺");
});

async function main() {
  const [state, config] = await Promise.all([loadState(), loadRemoteConfig()]);
  const target = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
  const count = getTodayContributions(state);

  if (!target.matched) {
    console.log(`Any Router 近 60m 状态: 未匹配目标站 · 贡献暂停 · ${formatContributionCount(count)}`);
    return;
  }

  const status = await getCachedStatus(config.apiBaseUrl);
  const statusText = formatStatus(status);
  const contributionText = config.reportingEnabled === false ? "贡献暂停" : "贡献开启";
  console.log(`Any Router 近 60m 状态: ${statusText} · ${contributionText} · ${formatContributionCount(count)}`);
}

async function getCachedStatus(apiBaseUrl: string): Promise<StatusSummary | null> {
  const nowMs = Date.now();
  const cached = await loadStatusCache();
  if (cached?.apiBaseUrl === apiBaseUrl && cached.fetchedAtMs + STATUS_CACHE_TTL_MS > nowMs) {
    return cached.status as StatusSummary | null;
  }

  const status = await fetchStatus(apiBaseUrl);
  await saveStatusCache({
    apiBaseUrl,
    fetchedAtMs: nowMs,
    status: status ? { ...status } : null
  });
  return status;
}

async function fetchStatus(apiBaseUrl: string): Promise<StatusSummary | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/v1/status?window=60m`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.json() as StatusSummary;
  } catch {
    return null;
  }
}

function formatStatus(status: StatusSummary | null): string {
  if (!status || status.state === "insufficient_data") return "观测中";
  if (status.state === "down") return "不可用";
  if (status.state === "unstable") return status.label || "失败偏高";
  return "可用";
}

function formatContributionCount(count: number): string {
  if (count >= LOCAL_DAILY_REPORT_LIMIT) return `今日贡献 ${count}/${LOCAL_DAILY_REPORT_LIMIT} 条 · 今日已满`;
  return `今日贡献 ${count} 条`;
}
