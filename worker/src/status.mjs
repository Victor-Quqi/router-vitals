const LATENCY_ORDER = Object.freeze([
  ["lt_3s", "latency_lt_3s"],
  ["3_10s", "latency_3_10s"],
  ["10_30s", "latency_10_30s"],
  ["30_60s", "latency_30_60s"],
  ["gt_60s", "latency_gt_60s"],
  ["unknown", "latency_unknown"]
]);

const ERROR_ORDER = Object.freeze([
  ["server_error", "err_server_error"],
  ["rate_limited", "err_rate_limited"],
  ["network_error", "err_network_error"],
  ["auth_error", "err_auth_error"],
  ["timeout", "err_timeout"],
  ["unknown", "err_unknown"]
]);

export function parseStatusWindow(value) {
  if (value === "5m") return 5;
  if (value === "15m") return 15;
  if (value === "60m") return 60;
  return null;
}

export function buildStatusFromRows(rows, windowValue) {
  const totals = sumRows(rows);
  const total = totals.total_samples;
  const availability = total > 0 ? totals.success_samples / total : null;
  const confidence = getConfidence(total);
  const latency = {
    p50: percentileBucket(totals.latency, 0.5),
    p90: percentileBucket(totals.latency, 0.9)
  };
  const errors = buildErrorBreakdown(totals.errors, totals.failure_samples);
  const state = getState({ total, availability, latency, errors });

  return {
    window: windowValue,
    generatedAt: new Date().toISOString(),
    state,
    label: labelForState(state, errors),
    sampleCount: total,
    successCount: totals.success_samples,
    failureCount: totals.failure_samples,
    availability,
    confidence,
    latency,
    errors,
    meta: {
      unit: "turn",
      availabilityFormula: "successCount / sampleCount",
      sampleCountDefinition: "Completed Claude Code user turns observed by the plugin in this window.",
      latencyDefinition: "End-to-end turn duration bucket from UserPromptSubmit to Stop or StopFailure.",
      latencyBuckets: ["lt_3s", "3_10s", "10_30s", "30_60s", "gt_60s", "unknown"],
      confidenceThresholds: {
        insufficient: "sampleCount < 5",
        low: "5 <= sampleCount < 20",
        medium: "20 <= sampleCount < 100",
        high: "sampleCount >= 100"
      },
      stateThresholds: {
        insufficient_data: "sampleCount < 5",
        down: "availability < 50%",
        unstable: "50% <= availability < 95%",
        slow: "availability >= 95% and p90 latency is 30_60s or gt_60s",
        available: "availability >= 95% and p90 latency is below 30s"
      }
    }
  };
}

function sumRows(rows) {
  const totals = {
    total_samples: 0,
    success_samples: 0,
    failure_samples: 0,
    latency: Object.fromEntries(LATENCY_ORDER.map(([key]) => [key, 0])),
    errors: Object.fromEntries(ERROR_ORDER.map(([key]) => [key, 0]))
  };

  for (const row of rows) {
    totals.total_samples += Number(row.total_samples || 0);
    totals.success_samples += Number(row.success_samples || 0);
    totals.failure_samples += Number(row.failure_samples || 0);
    for (const [key, column] of LATENCY_ORDER) totals.latency[key] += Number(row[column] || 0);
    for (const [key, column] of ERROR_ORDER) totals.errors[key] += Number(row[column] || 0);
  }

  return totals;
}

function percentileBucket(counts, percentile) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return "unknown";
  const threshold = Math.ceil(total * percentile);
  let seen = 0;
  for (const [bucket] of LATENCY_ORDER) {
    seen += counts[bucket] || 0;
    if (seen >= threshold) return bucket;
  }
  return "unknown";
}

function buildErrorBreakdown(counts, failureCount) {
  return ERROR_ORDER
    .map(([type]) => ({
      type,
      count: counts[type] || 0,
      ratio: failureCount > 0 ? (counts[type] || 0) / failureCount : 0
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function getConfidence(total) {
  if (total < 5) return "insufficient";
  if (total < 20) return "low";
  if (total < 100) return "medium";
  return "high";
}

function getState({ total, availability, latency }) {
  if (total < 5 || availability === null) return "insufficient_data";
  if (availability < 0.5) return "down";
  if (availability < 0.95) return "unstable";
  if (latency.p90 === "30_60s" || latency.p90 === "gt_60s") return "slow";
  return "available";
}

function labelForState(state, errors) {
  if (state === "unstable" && errors.length > 0) return `${errors[0].type} 偏高`;
  if (state === "down") return "不可用";
  if (state === "slow") return "可用但偏慢";
  if (state === "available") return "可用";
  return "样本不足";
}
