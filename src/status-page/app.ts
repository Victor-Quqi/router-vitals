const API_BASE = window.ANYROUTER_STATUS_API_BASE || "https://api.status.example.com";

type ServiceState = "available" | "unstable" | "down" | "insufficient_data";
type ModelClass = "haiku" | "sonnet" | "opus" | "unknown";
type BucketState = "empty" | "success" | "mixed" | "failure";
type RefreshOptions = { bypassCache?: boolean };

interface TimelineMeta {
  bucketMinutes: number;
  bucketCount: number;
  startAt: string;
  endAt: string;
}

interface TrendBucket {
  index: number;
  startAt: string;
  endAt: string;
  total?: number;
  success?: number;
  failure?: number;
  state?: BucketState;
  errors?: ErrorStatus[];
}

interface ModelStatus {
  modelClass: ModelClass | string;
  sampleCount?: number;
  successCount?: number;
  failureCount?: number;
  availability?: number | null;
  buckets?: TrendBucket[];
}

interface StatusCodeCount {
  code: number;
  count: number;
}

interface ErrorHintCount {
  text: string;
  count: number;
}

interface ErrorStatus {
  type?: string;
  count?: number;
  ratio?: number;
  statusCodes?: StatusCodeCount[];
  hints?: ErrorHintCount[];
}

interface StatusData {
  window?: string;
  generatedAt?: string;
  state?: ServiceState | string;
  label?: string;
  sampleCount?: number;
  successCount?: number;
  failureCount?: number;
  availability?: number | null;
  timeline?: TimelineMeta | null;
  models?: ModelStatus[];
  errors?: ErrorStatus[];
  modelErrors?: Partial<Record<ModelClass, ErrorStatus[]>>;
}

const labels: Record<ServiceState, string> = {
  available: "可用",
  unstable: "不稳定",
  down: "不可用",
  insufficient_data: "样本不足"
};

const windowLabels: Record<string, string> = {
  "60m": "近60分钟",
  "90m": "近90分钟",
  "24h": "近24小时",
  "7d": "近7天",
  "30d": "近30天"
};

const errorLabels: Record<string, { title: string; detail: string }> = {
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

const modelLabels: Record<ModelClass, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  unknown: "Unknown"
};

let activeWindow = "60m";
let activeErrorModel: ModelClass = "opus";
let latestStatusData: StatusData | null = null;
const openErrorKeys = new Set<string>();
const autoRefreshWindows = new Set(["60m", "24h"]);
const autoRefreshMs = 30000;
let autoRefreshTimer: number | undefined;
let autoRefreshEnabled = false;
let loadSequence = 0;

const refreshButton = getElement("refreshButton") as HTMLButtonElement;
const autoRefreshControl = getElement("autoRefreshControl") as HTMLLabelElement;
const autoRefreshToggle = getElement("autoRefreshToggle") as HTMLInputElement;
const trendTooltip = document.createElement("div");
trendTooltip.className = "trendTooltip";
document.body.append(trendTooltip);

for (const element of document.querySelectorAll("[data-window]")) {
  const button = element as HTMLButtonElement;
  button.addEventListener("click", () => {
    if (!button.dataset.window) return;
    activeWindow = button.dataset.window;
    document.querySelectorAll("[data-window]").forEach((item) => item.classList.toggle("active", item === button));
    syncRefreshControls();
    void loadStatus();
  });
}

for (const element of document.querySelectorAll("[data-error-model]")) {
  const button = element as HTMLButtonElement;
  button.addEventListener("click", () => {
    const model = normalizeModelClass(button.dataset.errorModel);
    activeErrorModel = model;
    document.querySelectorAll("[data-error-model]").forEach((item) => item.classList.toggle("active", item === button));
    if (latestStatusData) renderErrorsForModel(latestStatusData);
  });
}

refreshButton.addEventListener("click", () => {
  void loadStatus({ bypassCache: true });
});

autoRefreshToggle.addEventListener("change", () => {
  autoRefreshEnabled = autoRefreshToggle.checked;
  syncRefreshControls();
});

syncRefreshControls();
void loadStatus();

async function loadStatus(options: RefreshOptions = {}): Promise<void> {
  const sequence = ++loadSequence;
  const requestedWindow = activeWindow;
  refreshButton.disabled = true;
  try {
    const params = new URLSearchParams({ window: requestedWindow });
    if (options.bypassCache) params.set("refresh", "1");
    const response = await fetch(`${API_BASE.replace(/\/+$/, "")}/v1/status?${params}`, {
      cache: options.bypassCache ? "no-store" : "default",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as StatusData;
    if (sequence === loadSequence) render(data);
  } catch {
    if (sequence === loadSequence) renderUnavailable();
  } finally {
    if (sequence === loadSequence) refreshButton.disabled = false;
  }
}

function syncRefreshControls(): void {
  const supportsAutoRefresh = autoRefreshWindows.has(activeWindow);
  autoRefreshControl.hidden = !supportsAutoRefresh;
  autoRefreshToggle.checked = supportsAutoRefresh && autoRefreshEnabled;

  if (autoRefreshTimer !== undefined) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }

  if (supportsAutoRefresh && autoRefreshEnabled) {
    autoRefreshTimer = window.setInterval(() => {
      void loadStatus();
    }, autoRefreshMs);
  }
}

function render(data: StatusData): void {
  latestStatusData = data;
  const state = normalizeServiceState(data.state);
  setText("state", labels[state] || "状态暂缺");
  setText("stateDetail", formatStateDetail(data));
  setText("availability", formatPercent(data.availability));
  setText("sampleCount", String(data.sampleCount ?? "--"));
  setText("failureCountMetric", String(data.failureCount ?? "--"));
  setText("availabilityMath", formatAvailabilityMath(data));

  const stateNode = getElement("state");
  stateNode.className = `state ${state}`;
  renderModelTable(data.models || [], data.timeline);
  renderErrorsForModel(data);
}

function renderModelTable(models: ModelStatus[], timeline?: TimelineMeta | null): void {
  const root = getElement("modelTable");
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
    name.textContent = modelLabels[model.modelClass as ModelClass] || model.modelClass || "unknown";

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
      const tooltip = formatBucketTooltip(bucket);
      block.tabIndex = 0;
      block.setAttribute("aria-label", tooltip);
      bindTrendTooltip(block, tooltip);
      trend.append(block);
    }

    row.append(name, availability, sampleCount, failureCount, trend);
    root.append(row);
  }
}

function buildEmptyModels(timeline?: TimelineMeta | null): ModelStatus[] {
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
      state: "empty" as const
    }))
  }));
}

function minuteToIso(minute: number): string {
  return new Date(minute * 60000).toISOString();
}

function renderErrorsForModel(data: StatusData): void {
  const model = findModelStatus(data, activeErrorModel);
  const errors = data.modelErrors?.[activeErrorModel] || [];
  setText("failureCount", `${modelLabels[activeErrorModel]} · ${formatWindowLabel(data.window)} · 失败轮次 ${model?.failureCount ?? 0}`);
  renderErrors(errors);
}

function renderErrors(errors: ErrorStatus[]): void {
  const root = getElement("errors");
  root.replaceChildren();

  if (errors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "stateDetail";
    empty.textContent = `${modelLabels[activeErrorModel]} 当前窗口没有主要错误类型`;
    root.append(empty);
    return;
  }

  for (const error of errors.slice(0, 5)) {
    const item = document.createElement("div");
    item.className = "errorItem";
    const errorKey = getErrorKey(error);
    const expanded = openErrorKeys.has(errorKey);
    item.classList.toggle("expanded", expanded);
    const meta = errorLabels[error.type || "unknown"] || {
      title: "未识别错误",
      detail: "错误信息不足，暂未归类。"
    };

    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "errorSummary";
    summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    summary.addEventListener("click", () => {
      const nextExpanded = !item.classList.contains("expanded");
      item.classList.toggle("expanded", nextExpanded);
      summary.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
      if (nextExpanded) openErrorKeys.add(errorKey);
      else openErrorKeys.delete(errorKey);
    });

    const indicator = document.createElement("span");
    indicator.className = "disclosureIcon";
    indicator.setAttribute("aria-hidden", "true");

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

    summary.append(indicator, name, bar, ratio);
    item.append(summary, buildErrorDetail(error));
    root.append(item);
  }
}

function buildErrorDetail(error: ErrorStatus): HTMLElement {
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

function getErrorKey(error: ErrorStatus): string {
  const statusCodes = Array.isArray(error.statusCodes) ? error.statusCodes.map((item) => item.code).join("/") : "";
  return `${error.type || "unknown"}:${statusCodes}`;
}

function formatStatusSuffix(statusCodes?: StatusCodeCount[]): string {
  if (!Array.isArray(statusCodes) || statusCodes.length === 0) return "";
  return ` (${statusCodes.slice(0, 2).map((item) => item.code).join("/")})`;
}

function renderUnavailable(): void {
  latestStatusData = null;
  setText("state", "状态暂缺");
  setText("stateDetail", "API 暂时没有返回可用数据");
  for (const id of ["availability", "sampleCount", "failureCountMetric"]) setText(id, "--");
  setText("failureCount", formatWindowLabel(activeWindow));
  setText("availabilityMath", "--");
  getElement("state").className = "state insufficient_data";
  renderModelTable([], null);
  renderErrors([]);
}

function setText(id: string, value: string): void {
  getElement(id).textContent = value;
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element;
}

function formatRange(startAt: string, endAt: string): string {
  const options: Intl.DateTimeFormatOptions = activeWindow.endsWith("d")
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  const formatter = new Intl.DateTimeFormat("zh-CN", options);
  return `${formatter.format(new Date(startAt))} - ${formatter.format(new Date(endAt))}`;
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : "--";
}

function formatAvailabilityMath(data: StatusData): string {
  if (typeof data.successCount !== "number" || typeof data.sampleCount !== "number") return "--";
  if (data.sampleCount === 0) return "0 / 0";
  return `${data.successCount} / ${data.sampleCount}`;
}

function formatStateDetail(data: StatusData): string {
  const windowText = formatWindowLabel(data.window);
  const sampleCount = Number.isInteger(data.sampleCount) ? data.sampleCount : 0;
  if (data.state === "insufficient_data") return `${windowText}完成轮次 ${sampleCount} 条，暂不判断可用状态`;
  if (typeof data.availability === "number") {
    return `${windowText}成功轮次 ${data.successCount}/${data.sampleCount}，成功率 ${formatPercent(data.availability)}`;
  }
  return `${windowText}社区轮次观测`;
}

function formatWindowLabel(value?: string): string {
  return windowLabels[value || ""] || windowLabels[activeWindow] || activeWindow;
}

function formatDuration(minutes: number): string {
  if (minutes >= 1440) return `${minutes / 1440}天`;
  if (minutes >= 60) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function formatBucketTooltip(bucket: TrendBucket): string {
  const total = bucket.total ?? 0;
  const success = bucket.success ?? 0;
  const failure = bucket.failure ?? 0;
  const lines = [formatRange(bucket.startAt, bucket.endAt)];

  if (total <= 0) {
    lines.push("无数据");
    return lines.join("\n");
  }

  lines.push(`成功 ${success} · 失败 ${failure} · 总轮次 ${total}`);
  lines.push(`成功率 ${formatPercent(total > 0 ? success / total : null)}`);

  if (failure > 0) {
    const primaryError = bucket.errors?.[0];
    lines.push(primaryError ? `主要错误：${formatPrimaryError(primaryError)}` : "主要错误：暂无明细");
  }

  return lines.join("\n");
}

function formatPrimaryError(error: ErrorStatus): string {
  const meta = errorLabels[error.type || "unknown"] || { title: "未识别错误", detail: "" };
  const statusCode = error.statusCodes?.[0]?.code;
  const count = error.count ?? 0;
  const parts = [meta.title];
  if (statusCode) parts.push(`HTTP ${statusCode}`);
  if (count > 0) parts.push(`${count} 次`);
  return parts.join(" · ");
}

function normalizeServiceState(value: unknown): ServiceState {
  if (value === "available" || value === "unstable" || value === "down" || value === "insufficient_data") return value;
  return "insufficient_data";
}

function normalizeModelClass(value: unknown): ModelClass {
  if (value === "opus" || value === "sonnet" || value === "haiku" || value === "unknown") return value;
  return "unknown";
}

function findModelStatus(data: StatusData, modelClass: ModelClass): ModelStatus | undefined {
  return (data.models || []).find((model) => model.modelClass === modelClass);
}

function bindTrendTooltip(element: HTMLElement, text: string): void {
  element.addEventListener("mouseenter", (event) => {
    showTrendTooltip(text);
    positionTrendTooltip(event.clientX, event.clientY);
  });
  element.addEventListener("mousemove", (event) => {
    positionTrendTooltip(event.clientX, event.clientY);
  });
  element.addEventListener("mouseleave", hideTrendTooltip);
  element.addEventListener("focus", () => {
    const rect = element.getBoundingClientRect();
    showTrendTooltip(text);
    positionTrendTooltip(rect.left + rect.width / 2, rect.top);
  });
  element.addEventListener("blur", hideTrendTooltip);
}

function showTrendTooltip(text: string): void {
  trendTooltip.textContent = text;
  trendTooltip.classList.add("visible");
}

function hideTrendTooltip(): void {
  trendTooltip.classList.remove("visible");
}

function positionTrendTooltip(clientX: number, clientY: number): void {
  const margin = 12;
  const x = Math.min(window.innerWidth - margin, Math.max(margin, clientX));
  const y = Math.min(window.innerHeight - margin, Math.max(margin, clientY));
  trendTooltip.style.left = `${x}px`;
  trendTooltip.style.top = `${y}px`;
}
