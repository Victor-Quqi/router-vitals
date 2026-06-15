const API_BASE = window.ANYROUTER_STATUS_API_BASE || "https://api.status.example.com";

const labels = {
  available: "可用",
  unstable: "不稳定",
  down: "不可用",
  insufficient_data: "样本不足"
};

const windowLabels = {
  "60m": "近60分钟",
  "90m": "近90分钟",
  "24h": "近24小时",
  "7d": "近7天",
  "30d": "近30天"
};

const errorLabels = {
  server_error: {
    title: "上游服务错误",
    detail: "上游返回服务错误或过载。"
  },
  rate_limited: {
    title: "限流 / 额度",
    detail: "请求被限流或额度不足。"
  },
  network_error: {
    title: "网络连接错误",
    detail: "连接建立、DNS 或传输阶段失败。"
  },
  auth_error: {
    title: "认证 / 权限错误",
    detail: "认证失败、权限不足或账号不可用。"
  },
  timeout: {
    title: "超时",
    detail: "请求超时或连接超时。"
  },
  unknown: {
    title: "未识别错误",
    detail: "错误信息不足，暂未归类。"
  }
};

const modelLabels = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
  unknown: "unknown"
};

let activeWindow = "60m";
const openErrorKeys = new Set();

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
    const item = document.createElement("details");
    item.className = "errorItem";
    const errorKey = getErrorKey(error);
    item.open = openErrorKeys.has(errorKey);
    item.addEventListener("toggle", () => {
      if (item.open) openErrorKeys.add(errorKey);
      else openErrorKeys.delete(errorKey);
    });
    const meta = errorLabels[error.type] || {
      title: "未识别错误",
      detail: "错误信息不足，暂未归类。"
    };

    const summary = document.createElement("summary");
    summary.className = "errorSummary";

    const name = document.createElement("div");
    name.className = "errorName";
    const title = document.createElement("strong");
    title.textContent = `${meta.title}${formatStatusSuffix(error.statusCodes)}`;
    const detail = document.createElement("em");
    detail.textContent = meta.detail;
    name.append(title, detail);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.round((error.ratio || 0) * 100)}%`;
    bar.append(fill);

    const ratio = document.createElement("span");
    ratio.textContent = `${Math.round((error.ratio || 0) * 100)}%`;

    summary.append(name, bar, ratio);
    item.append(summary, buildErrorDetail(error));
    root.append(item);
  }
}

function buildErrorDetail(error) {
  const root = document.createElement("div");
  root.className = "errorDetail";

  const statusLine = document.createElement("p");
  statusLine.textContent = error.statusCodes?.length
    ? `HTTP 状态码：${error.statusCodes.map((item) => `${item.code} x${item.count}`).join("，")}`
    : "HTTP 状态码：暂无";
  root.append(statusLine);

  if (error.hints?.length) {
    const title = document.createElement("p");
    title.textContent = "错误摘要：";
    root.append(title);

    const list = document.createElement("ul");
    for (const hint of error.hints) {
      const item = document.createElement("li");
      item.textContent = `${hint.text}${hint.count > 1 ? ` x${hint.count}` : ""}`;
      list.append(item);
    }
    root.append(list);
  } else {
    const empty = document.createElement("p");
    empty.textContent = "错误摘要：暂无";
    root.append(empty);
  }
  return root;
}

function getErrorKey(error) {
  const statusCodes = Array.isArray(error.statusCodes) ? error.statusCodes.map((item) => item.code).join("/") : "";
  return `${error.type || "unknown"}:${statusCodes}`;
}

function formatStatusSuffix(statusCodes) {
  if (!Array.isArray(statusCodes) || statusCodes.length === 0) return "";
  return ` (${statusCodes.slice(0, 2).map((item) => item.code).join("/")})`;
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
