const API_BASE = window.ANYROUTER_STATUS_API_BASE || "https://api.status.example.com";

const labels = {
  available: "可用",
  slow: "偏慢",
  unstable: "不稳定",
  down: "不可用",
  insufficient_data: "样本不足"
};

const latencyLabels = {
  lt_3s: "<3s",
  "3_10s": "3-10s",
  "10_30s": "10-30s",
  "30_60s": "30-60s",
  gt_60s: ">60s",
  unknown: "--"
};

const confidenceLabels = {
  insufficient: "不足",
  low: "低",
  medium: "中",
  high: "高"
};

const errorLabels = {
  server_error: "server_error",
  rate_limited: "rate_limited",
  network_error: "network_error",
  auth_error: "auth_error",
  timeout: "timeout",
  unknown: "unknown"
};

let activeWindow = "5m";

for (const button of document.querySelectorAll("[data-window]")) {
  button.addEventListener("click", () => {
    activeWindow = button.dataset.window;
    document.querySelectorAll("[data-window]").forEach((item) => item.classList.toggle("active", item === button));
    loadStatus();
  });
}

loadStatus();
setInterval(loadStatus, 30000);

async function loadStatus() {
  try {
    const response = await fetch(`${API_BASE.replace(/\/+$/, "")}/v1/status?window=${activeWindow}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch {
    renderUnavailable();
  }
}

function render(data) {
  const state = data.state || "insufficient_data";
  setText("state", labels[state] || "状态暂缺");
  setText("stateDetail", data.label || "社区观测结果暂不可用");
  setText("updated", data.generatedAt ? `更新于 ${formatTime(data.generatedAt)}` : "等待数据");
  setText("availability", typeof data.availability === "number" ? `${Math.round(data.availability * 1000) / 10}%` : "--");
  setText("sampleCount", String(data.sampleCount ?? "--"));
  setText("p50", latencyLabels[data.latency?.p50] || "--");
  setText("p90", latencyLabels[data.latency?.p90] || "--");
  setText("confidence", confidenceLabels[data.confidence] || "--");
  setText("failureCount", `失败样本 ${data.failureCount ?? "--"}`);

  const stateNode = document.getElementById("state");
  stateNode.className = `state ${state}`;
  renderErrors(data.errors || []);
}

function renderErrors(errors) {
  const root = document.getElementById("errors");
  root.replaceChildren();

  if (errors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "stateDetail";
    empty.textContent = "当前窗口没有主要错误类型";
    root.append(empty);
    return;
  }

  for (const error of errors.slice(0, 5)) {
    const item = document.createElement("div");
    item.className = "errorItem";

    const name = document.createElement("strong");
    name.textContent = errorLabels[error.type] || error.type;

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.round((error.ratio || 0) * 100)}%`;
    bar.append(fill);

    const ratio = document.createElement("span");
    ratio.textContent = `${Math.round((error.ratio || 0) * 100)}%`;

    item.append(name, bar, ratio);
    root.append(item);
  }
}

function renderUnavailable() {
  setText("state", "状态暂缺");
  setText("stateDetail", "API 暂时没有返回可用数据");
  setText("updated", "等待数据");
  for (const id of ["availability", "sampleCount", "p50", "p90", "confidence"]) setText(id, "--");
  setText("failureCount", "失败样本 --");
  document.getElementById("state").className = "state insufficient_data";
  renderErrors([]);
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
