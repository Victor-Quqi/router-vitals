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
  const errors = buildErrorBreakdown(totals.errors, totals.failure_samples);
  const state = getState({ total, availability });

  return {
    window: windowValue,
    generatedAt: new Date().toISOString(),
    state,
    label: labelForState(state, errors),
    sampleCount: total,
    successCount: totals.success_samples,
    failureCount: totals.failure_samples,
    availability,
    errors,
    meta: {
      unit: "turn",
      availabilityFormula: "successCount / sampleCount",
      sampleCountDefinition: "Completed Claude Code user turns observed by the plugin in this window.",
      stateThresholds: {
        insufficient_data: "sampleCount < 5",
        down: "availability < 50%",
        unstable: "50% <= availability < 95%",
        available: "availability >= 95%"
      }
    }
  };
}

function sumRows(rows) {
  const totals = {
    total_samples: 0,
    success_samples: 0,
    failure_samples: 0,
    errors: Object.fromEntries(ERROR_ORDER.map(([key]) => [key, 0]))
  };

  for (const row of rows) {
    totals.total_samples += Number(row.total_samples || 0);
    totals.success_samples += Number(row.success_samples || 0);
    totals.failure_samples += Number(row.failure_samples || 0);
    for (const [key, column] of ERROR_ORDER) totals.errors[key] += Number(row[column] || 0);
  }

  return totals;
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

function getState({ total, availability }) {
  if (total < 5 || availability === null) return "insufficient_data";
  if (availability < 0.5) return "down";
  if (availability < 0.95) return "unstable";
  return "available";
}

function labelForState(state, errors) {
  if (state === "unstable" && errors.length > 0) {
    return errors[0].type === "unknown" ? "失败偏高" : `${errors[0].type} 偏高`;
  }
  if (state === "down") return "不可用";
  if (state === "available") return "可用";
  return "样本不足";
}
