const API_BASE = window.ANYROUTER_STATUS_API_BASE || "https://api.status.example.com";

const labels = {
  available: "可用",
  unstable: "不稳定",
  down: "不可用",
  insufficient_data: "样本不足"
};

const windowLabels = {
  "90m": "近90分钟",
  "24h": "近24小时",
  "7d": "近7天",
  "30d": "近30天",
  "60m": "近60分钟"
};

const errorLabels = {
  server_error: "server_error",
  rate_limited: "rate_limited",
  network_error: "network_error",
  auth_error: "auth_error",
  timeout: "timeout",
  unknown: "unknown"
};

const modelLabels = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
  unknown: "unknown"
};

let activeWindow = "90m";

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
  setText("stateDetail", formatStateDetail(data));
  setText("updated", data.generatedAt ? `更新于 ${formatTime(data.generatedAt)}` : "等待数据");
  setText("availability", formatPercent(data.availability));
  setText("sampleCount", String(data.sampleCount ?? "--"));
  setText("failureCountMetric", String(data.failureCount ?? "--"));
  setText("failureCount", `${formatWindowLabel(data.window)} · 失败轮次 ${data.failureCount ?? "--"}`);
  setText("availabilityMath", formatAvailabilityMath(data));
  setText("bucketInfo", formatBucketInfo(data.timeline));

  const stateNode = document.getElementById("state");
  stateNode.className = `state ${state}`;
  renderModelTable(data.models || [], data.timeline);
  renderErrors(data.errors || []);
}

function renderModelTable(models, timeline) {
  const root = document.getElementById("modelTable");
  root.replaceChildren();
  root.style.setProperty("--bucket-count", String(timeline?.bucketCount || 1));
  const rows = models.length > 0 ? models : buildEmptyModels(timeline);

  const header = document.createElement("div");
  header.className = "modelRow modelHead";
  for (const text of ["模型", "可用率", "轮次", "失败", "趋势"]) {
    const cell = document.createElement("span");
    cell.textContent = text;
    header.append(cell);
  }
  root.append(header);

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyTrend";
    empty.textContent = "当前窗口没有可展示的模型趋势";
    root.append(empty);
    return;
  }

  for (const model of rows) {
    const row = document.createElement("div");
    row.className = "modelRow";

    const name = document.createElement("strong");
    name.textContent = modelLabels[model.modelClass] || model.modelClass || "unknown";

    const availability = document.createElement("span");
    availability.textContent = formatPercent(model.availability);

    const sampleCount = document.createElement("span");
    sampleCount.textContent = String(model.sampleCount ?? 0);

    const failureCount = document.createElement("span");
    failureCount.textContent = String(model.failureCount ?? 0);

    const trend = document.createElement("div");
    trend.className = "trendStrip";
    for (const bucket of model.buckets || []) {
      const block = document.createElement("span");
      block.className = `trendBlock ${bucket.state || "empty"}`;
      block.title = formatBucketTitle(bucket);
      block.setAttribute("aria-label", block.title);
      trend.append(block);
    }

    row.append(name, availability, sampleCount, failureCount, trend);
    root.append(row);
  }
}

function buildEmptyModels(timeline) {
  if (!timeline?.bucketCount) return [];
  const startMinute = Math.floor(new Date(timeline.startAt).getTime() / 60000);
  const endMinute = Math.floor(new Date(timeline.endAt).getTime() / 60000);
  return Object.keys(modelLabels).map((modelClass) => ({
    modelClass,
    sampleCount: 0,
    failureCount: 0,
    availability: null,
    buckets: Array.from({ length: timeline.bucketCount }, (_, index) => ({
      index,
      startAt: minuteToIso(startMinute + index * timeline.bucketMinutes),
      endAt: minuteToIso(Math.min(startMinute + (index + 1) * timeline.bucketMinutes - 1, endMinute)),
      total: 0,
      success: 0,
      failure: 0,
      state: "empty"
    }))
  }));
}

function minuteToIso(minute) {
  return new Date(minute * 60000).toISOString();
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
  for (const id of ["availability", "sampleCount", "failureCountMetric"]) setText(id, "--");
  setText("failureCount", formatWindowLabel(activeWindow));
  setText("availabilityMath", "--");
  setText("bucketInfo", "--");
  document.getElementById("state").className = "state insufficient_data";
  renderModelTable([], null);
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

function formatRange(startAt, endAt) {
  const options = activeWindow.endsWith("d")
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  const formatter = new Intl.DateTimeFormat("zh-CN", options);
  return `${formatter.format(new Date(startAt))} - ${formatter.format(new Date(endAt))}`;
}

function formatPercent(value) {
  return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : "--";
}

function formatAvailabilityMath(data) {
  if (!data || typeof data.successCount !== "number" || typeof data.sampleCount !== "number") return "--";
  if (data.sampleCount === 0) return "0 / 0";
  return `${data.successCount} / ${data.sampleCount}`;
}

function formatStateDetail(data) {
  const windowText = formatWindowLabel(data.window);
  const sampleCount = Number.isInteger(data.sampleCount) ? data.sampleCount : 0;
  if (data.state === "insufficient_data") return `${windowText}完成轮次 ${sampleCount} 条，暂不判断可用状态`;
  if (typeof data.availability === "number") {
    return `${windowText}成功轮次 ${data.successCount}/${data.sampleCount}，成功率 ${formatPercent(data.availability)}`;
  }
  return `${windowText}社区轮次观测`;
}

function formatWindowLabel(value) {
  return windowLabels[value] || windowLabels[activeWindow] || activeWindow;
}

function formatBucketInfo(timeline) {
  if (!timeline) return "--";
  return `${timeline.bucketCount} 格 · 每格 ${formatDuration(timeline.bucketMinutes)}`;
}

function formatDuration(minutes) {
  if (minutes >= 1440) return `${minutes / 1440}天`;
  if (minutes >= 60) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function formatBucketTitle(bucket) {
  const total = bucket.total ?? 0;
  const success = bucket.success ?? 0;
  const failure = bucket.failure ?? 0;
  return `${formatRange(bucket.startAt, bucket.endAt)} · 成功 ${success} · 失败 ${failure} · 总轮次 ${total}`;
}
