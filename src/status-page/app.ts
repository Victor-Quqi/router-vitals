import { SITE_CONFIG } from "../shared/site-config.mjs";

const API_BASE = window.ROUTER_VITALS_API_BASE || window.location.origin;

type ServiceState = "available" | "unstable" | "down" | "insufficient_data";
type ModelClass = "haiku" | "sonnet" | "opus" | "fable" | "gpt-5.5" | "unknown";
type BucketState = "empty" | "success" | "mixed" | "failure";
type RefreshOptions = { bypassCache?: boolean };
type EndpointId = (typeof SITE_CONFIG.endpoints)[number]["id"];
type TargetHostFilter = "all" | EndpointId;
type ThemeMode = "system" | "light" | "dark";
type AssistantStartBucket = "lt_3s" | "3_10s" | "10_30s" | "30_60s" | "gt_60s" | "unknown";

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
  assistantStart?: AssistantStartSummary | null;
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

interface AssistantStartSummary {
  total?: number;
  known?: number;
  unknown?: number;
  medianBucket?: AssistantStartBucket | null;
  buckets?: Partial<Record<AssistantStartBucket, number>>;
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
  assistantStart?: AssistantStartSummary;
  timeline?: TimelineMeta | null;
  models?: ModelStatus[];
  errors?: ErrorStatus[];
  modelErrors?: Partial<Record<ModelClass, ErrorStatus[]>>;
}

interface SelectedTrendBucket {
  modelClass: ModelClass;
  bucketIndex: number;
  startAt: string;
  endAt: string;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  availability: number | null;
  assistantStart?: AssistantStartSummary | null;
  errors: ErrorStatus[];
}

interface DisplayScope {
  selected: boolean;
  modelClass?: ModelClass | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  sampleCount?: number | undefined;
  successCount?: number | undefined;
  failureCount?: number | undefined;
  availability?: number | null | undefined;
  assistantStart?: AssistantStartSummary | null | undefined;
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
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  "gpt-5.5": "GPT",
  unknown: "Unknown"
};
const defaultModelClasses: readonly ModelClass[] = ["fable", "opus", "sonnet", "haiku", "gpt-5.5"];

const assistantStartLabels: Record<AssistantStartBucket, string> = {
  lt_3s: "<3s",
  "3_10s": "3-10s",
  "10_30s": "10-30s",
  "30_60s": "30-60s",
  gt_60s: ">60s",
  unknown: "--"
};

const storageKeyPrefix = SITE_CONFIG.marketplace.name;
const errorModelStorageKey = `${storageKeyPrefix}-error-model`;
const targetHostStorageKey = `${storageKeyPrefix}-target-host`;
const targetHostParams = new Map<string, string>(SITE_CONFIG.endpoints.map((endpoint) => [endpoint.id, endpoint.host]));
let activeWindow = "60m";
let activeErrorModel: ModelClass = readErrorModel();
let activeTargetHost: TargetHostFilter = readTargetHostFilter();
let latestStatusData: StatusData | null = null;
let selectedTrendBucket: SelectedTrendBucket | null = null;
const openErrorKeys = new Set<string>();
const autoRefreshWindows = new Set(["60m", "24h"]);
const autoRefreshMs = 30000;
const themeStorageKey = `${storageKeyPrefix}-theme`;
const themeModes: readonly ThemeMode[] = ["system", "light", "dark"];
const themeLabels: Record<ThemeMode, string> = {
  system: "主题：跟随系统",
  light: "主题：浅色",
  dark: "主题：深色"
};
let autoRefreshTimer: number | undefined;
let autoRefreshEnabled = false;
let loadSequence = 0;
let manualRefreshTimer: number | undefined;

const refreshButton = getElement("refreshButton") as HTMLButtonElement;
const themeButton = getElement("themeButton") as HTMLButtonElement;
const autoRefreshControl = getElement("autoRefreshControl") as HTMLLabelElement;
const autoRefreshToggle = getElement("autoRefreshToggle") as HTMLInputElement;
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: light)");
let activeThemeMode = readThemeMode();
const trendTooltip = document.createElement("div");
trendTooltip.className = "trendTooltip";
document.body.append(trendTooltip);

applyTheme(activeThemeMode);

themeButton.addEventListener("click", () => {
  const index = themeModes.indexOf(activeThemeMode);
  activeThemeMode = themeModes[(index + 1) % themeModes.length] ?? "system";
  saveThemeMode(activeThemeMode);
  applyTheme(activeThemeMode);
});

systemThemeQuery.addEventListener("change", () => {
  if (activeThemeMode === "system") applyTheme(activeThemeMode);
});

for (const element of document.querySelectorAll("[data-window]")) {
  const button = element as HTMLButtonElement;
  button.addEventListener("click", () => {
    if (!button.dataset.window) return;
    activeWindow = button.dataset.window;
    selectedTrendBucket = null;
    document.querySelectorAll("[data-window]").forEach((item) => item.classList.toggle("active", item === button));
    syncRefreshControls();
    void loadStatus();
  });
}

refreshButton.addEventListener("click", () => {
  playManualRefreshSpin();
  void loadStatus({ bypassCache: true });
});

renderEndpointTabs();

for (const element of document.querySelectorAll("[data-target-host]")) {
  const button = element as HTMLButtonElement;
  button.addEventListener("click", () => {
    activeTargetHost = normalizeTargetHostFilter(button.dataset.targetHost);
    saveTargetHostFilter(activeTargetHost);
    syncTargetHostTabs();
    openErrorKeys.clear();
    selectedTrendBucket = null;
    void loadStatus();
  });
}

autoRefreshToggle.addEventListener("change", () => {
  autoRefreshEnabled = autoRefreshToggle.checked;
  syncRefreshControls();
});

syncRefreshControls();
syncTargetHostTabs();
syncErrorModelTabs();
void loadStatus();

async function loadStatus(options: RefreshOptions = {}): Promise<void> {
  const sequence = ++loadSequence;
  const requestedWindow = activeWindow;
  refreshButton.disabled = true;
  try {
    const params = new URLSearchParams({ window: requestedWindow });
    const targetHost = activeTargetHost === "all" ? null : targetHostParams.get(activeTargetHost);
    if (targetHost) params.set("targetHost", targetHost);
    if (options.bypassCache) params.set("refresh", "1");
    const response = await fetch(`${API_BASE.replace(/\/+$/, "")}/v1/status?${params}`, {
      cache: options.bypassCache ? "no-store" : "default",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("API base 配置异常，状态接口返回了非 JSON 内容");
    }
    const data = await response.json() as StatusData;
    if (sequence === loadSequence) render(data);
  } catch (error) {
    if (sequence === loadSequence) renderUnavailable(getStatusLoadErrorMessage(error));
  } finally {
    if (sequence === loadSequence) refreshButton.disabled = false;
  }
}

function syncRefreshControls(): void {
  const supportsAutoRefresh = autoRefreshWindows.has(activeWindow);
  autoRefreshControl.hidden = !supportsAutoRefresh;
  autoRefreshToggle.checked = supportsAutoRefresh && autoRefreshEnabled;
  refreshButton.classList.toggle("spinning", supportsAutoRefresh && autoRefreshEnabled);

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

function playManualRefreshSpin(): void {
  if (manualRefreshTimer !== undefined) window.clearTimeout(manualRefreshTimer);
  refreshButton.classList.remove("manualSpin");
  void refreshButton.offsetWidth;
  refreshButton.classList.add("manualSpin");
  manualRefreshTimer = window.setTimeout(() => {
    refreshButton.classList.remove("manualSpin");
    manualRefreshTimer = undefined;
  }, 700);
}

function readThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem(themeStorageKey);
    if (value === "light" || value === "dark") return value;
  } catch {
    return "system";
  }
  return "system";
}

function saveThemeMode(mode: ThemeMode): void {
  try {
    if (mode === "system") localStorage.removeItem(themeStorageKey);
    else localStorage.setItem(themeStorageKey, mode);
  } catch {
    return;
  }
}

function readErrorModel(): ModelClass {
  try {
    const value = localStorage.getItem(errorModelStorageKey);
    const modelClass = normalizeModelClass(value);
    if (modelClass !== "unknown") return modelClass;
  } catch {
    return "fable";
  }
  return "fable";
}

function saveErrorModel(modelClass: ModelClass): void {
  try {
    if (modelClass !== "unknown") localStorage.setItem(errorModelStorageKey, modelClass);
  } catch {
    return;
  }
}

function readTargetHostFilter(): TargetHostFilter {
  try {
    return normalizeTargetHostFilter(localStorage.getItem(targetHostStorageKey));
  } catch {
    return "all";
  }
}

function saveTargetHostFilter(value: TargetHostFilter): void {
  try {
    if (value === "all") localStorage.removeItem(targetHostStorageKey);
    else localStorage.setItem(targetHostStorageKey, value);
  } catch {
    return;
  }
}

function syncTargetHostTabs(): void {
  document.querySelectorAll("[data-target-host]").forEach((item) => {
    const selected = normalizeTargetHostFilter((item as HTMLElement).dataset.targetHost) === activeTargetHost;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function renderEndpointTabs(): void {
  const root = getElement("endpointTabs");
  for (const endpoint of SITE_CONFIG.endpoints) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.targetHost = endpoint.id;
    button.textContent = endpoint.label;
    root.append(button);
  }
}

function applyTheme(mode: ThemeMode): void {
  const resolved = mode === "system" ? (systemThemeQuery.matches ? "light" : "dark") : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  themeButton.dataset.themeMode = mode;
  themeButton.setAttribute("aria-label", themeLabels[mode]);
  themeButton.title = themeLabels[mode];
}

function render(data: StatusData): void {
  latestStatusData = data;
  syncSelectedTrendBucket(data);
  const scope = getDisplayScope(data);
  const state = getDisplayState(data, scope);
  setText("state", labels[state] || "状态暂缺");
  renderStateDetail(data, state, scope);
  setText("updatedAt", formatUpdatedAt(data.generatedAt));
  setText("availability", formatPercent(scope.availability));
  setText("sampleCount", formatCount(scope.sampleCount));
  setText("failureCountMetric", formatCount(scope.failureCount));
  setText("availabilityMath", formatAvailabilityMath(scope));
  setText("assistantStart", formatAssistantStart(scope.assistantStart || undefined, scope.successCount));
  setText("assistantStartDetail", formatAssistantStartDetail(scope.assistantStart || undefined, scope.successCount));

  const stateNode = getElement("state");
  stateNode.className = `state ${state}`;
  renderModelTable(data.models || [], data.timeline);
  renderErrorsForModel(data);
}

function renderModelTable(models: ModelStatus[], timeline?: TimelineMeta | null): void {
  const root = getElement("modelTable");
  root.replaceChildren();
  root.style.setProperty("--bucket-count", String(timeline?.bucketCount || 1));
  const rows = getVisibleModelRows(models, timeline);

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
    const modelClass = normalizeModelClass(model.modelClass);

    const name = document.createElement("strong");
    name.textContent = modelLabels[modelClass] || model.modelClass || "unknown";

    const availability = document.createElement("span");
    availability.textContent = formatPercent(model.availability);

    const sampleCount = document.createElement("span");
    sampleCount.textContent = String(model.sampleCount ?? 0);

    const failureCount = document.createElement("span");
    failureCount.textContent = String(model.failureCount ?? 0);

    const trendCell = document.createElement("div");
    trendCell.className = "trendCell";

    const trend = document.createElement("div");
    trend.className = "trendStrip";
    for (const bucket of model.buckets || []) {
      const block = document.createElement("span");
      block.className = `trendBlock ${bucket.state || "empty"}`;
      block.classList.toggle("selected", isSelectedTrendBucket(modelClass, bucket));
      const tooltip = formatBucketTooltip(bucket);
      block.tabIndex = 0;
      block.setAttribute("role", "button");
      block.setAttribute("aria-label", `${tooltip}\n查看该时间段状态详情`);
      bindTrendTooltip(block, tooltip);
      bindTrendSelection(block, modelClass, bucket);
      trend.append(block);
    }
    trendCell.append(trend, buildTrendAxis(model.buckets || []));

    row.append(name, availability, sampleCount, failureCount, trendCell);
    root.append(row);
    alignTrendCellScroll(trendCell);
  }
}

function alignTrendCellScroll(trendCell: HTMLElement): void {
  requestAnimationFrame(() => {
    const maxScrollLeft = trendCell.scrollWidth - trendCell.clientWidth;
    if (maxScrollLeft <= 0) return;

    const selected = trendCell.querySelector<HTMLElement>(".trendBlock.selected");
    if (!selected) {
      trendCell.scrollLeft = maxScrollLeft;
      return;
    }

    const target = selected.offsetLeft - (trendCell.clientWidth - selected.offsetWidth) / 2;
    trendCell.scrollLeft = Math.min(Math.max(0, target), maxScrollLeft);
  });
}

function buildEmptyModels(timeline?: TimelineMeta | null): ModelStatus[] {
  if (!timeline?.bucketCount) return [];
  const startMinute = Math.floor(new Date(timeline.startAt).getTime() / 60000);
  const endMinute = Math.floor(new Date(timeline.endAt).getTime() / 60000);
  return defaultModelClasses.map((modelClass) => ({
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

function getVisibleModelRows(models: ModelStatus[], timeline?: TimelineMeta | null): ModelStatus[] {
  return models.length > 0 ? filterVisibleModels(models) : buildEmptyModels(timeline);
}

function filterVisibleModels(models: ModelStatus[]): ModelStatus[] {
  return models.filter((model) => normalizeModelClass(model.modelClass) !== "unknown" || hasModelData(model));
}

function getVisibleModelClasses(data: StatusData): ModelClass[] {
  const classes: ModelClass[] = [];
  for (const model of getVisibleModelRows(data.models || [], data.timeline)) {
    const modelClass = normalizeModelClass(model.modelClass);
    if (!classes.includes(modelClass)) classes.push(modelClass);
  }
  return classes.length > 0 ? classes : [...defaultModelClasses];
}

function hasModelData(model: ModelStatus): boolean {
  if ((model.sampleCount ?? 0) > 0 || (model.failureCount ?? 0) > 0) return true;
  return (model.buckets || []).some((bucket) =>
    (bucket.total ?? 0) > 0 ||
    (bucket.success ?? 0) > 0 ||
    (bucket.failure ?? 0) > 0 ||
    (bucket.errors?.length ?? 0) > 0
  );
}

function minuteToIso(minute: number): string {
  return new Date(minute * 60000).toISOString();
}

function renderErrorsForModel(data: StatusData): void {
  syncErrorModelTabs(data);
  const model = findModelStatus(data, activeErrorModel);
  if (selectedTrendBucket?.modelClass === activeErrorModel) {
    setText(
      "failureCount",
      `${modelLabels[activeErrorModel]} · ${formatRange(selectedTrendBucket.startAt, selectedTrendBucket.endAt)} · 失败轮次 ${selectedTrendBucket.failureCount}`
    );
    renderErrors(
      selectedTrendBucket.errors,
      selectedTrendBucket.failureCount > 0 ? "该时间段没有主要错误类型" : "该时间段没有失败轮次"
    );
    return;
  }

  const errors = data.modelErrors?.[activeErrorModel] || [];
  setText("failureCount", `${formatWindowLabel(data.window)} · 失败轮次 ${model?.failureCount ?? 0}`);
  renderErrors(errors, "当前窗口没有主要错误类型");
}

function renderErrors(errors: ErrorStatus[], emptyText = "当前窗口没有主要错误类型"): void {
  const root = getElement("errors");
  root.replaceChildren();

  if (errors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "stateDetail";
    empty.textContent = emptyText;
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

function getStatusLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "API 暂时没有返回可用数据";
}

function renderUnavailable(detail = "API 暂时没有返回可用数据"): void {
  latestStatusData = null;
  selectedTrendBucket = null;
  setText("state", "状态暂缺");
  setText("stateDetail", detail);
  setText("updatedAt", "更新于 --");
  for (const id of ["availability", "sampleCount", "failureCountMetric", "assistantStart"]) setText(id, "--");
  setText("failureCount", formatWindowLabel(activeWindow));
  setText("availabilityMath", "--");
  setText("assistantStartDetail", "--");
  getElement("state").className = "state insufficient_data";
  renderModelTable([], null);
  syncErrorModelTabs();
  renderErrors([]);
}

function setText(id: string, value: string): void {
  getElement(id).textContent = value;
}

function renderStateDetail(data: StatusData, state: ServiceState, scope: DisplayScope): void {
  const root = getElement("stateDetail");
  root.replaceChildren(document.createTextNode(formatStateDetail(data, scope)));
  if (scope.selected) {
    root.append(document.createTextNode(" · "), buildClearScopeButton());
    return;
  }
  if (state !== "insufficient_data") return;

  const link = document.createElement("a");
  link.href = `${SITE_CONFIG.marketplace.repoUrl}#%E5%AE%89%E8%A3%85`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "安装插件贡献观测";
  root.append(document.createTextNode(" · "), link);
}

function buildClearScopeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "clearScopeButton";
  button.textContent = "清除";
  button.setAttribute("aria-label", "清除时间段选择");
  button.addEventListener("click", clearTrendSelection);
  return button;
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

function formatTrendTickLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = activeWindow === "7d" || activeWindow === "30d"
    ? { month: "2-digit", day: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : "--";
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "--";
}

function formatAvailabilityMath(scope: DisplayScope): string {
  if (typeof scope.successCount !== "number" || typeof scope.sampleCount !== "number") return "--";
  if (scope.sampleCount === 0) return "0 / 0";
  return `${scope.successCount} / ${scope.sampleCount}`;
}

function formatAssistantStart(value?: AssistantStartSummary, successCount?: number): string {
  if (typeof successCount === "number" && successCount <= 0) return "--";
  const bucket = value?.medianBucket;
  return bucket ? assistantStartLabels[bucket] : "--";
}

function formatAssistantStartDetail(value?: AssistantStartSummary, successCount?: number): string {
  if (typeof successCount === "number" && successCount <= 0) return "无成功样本";
  const known = Number(value?.known ?? 0);
  const total = Number(value?.total ?? 0);
  if (known <= 0) return "暂无已知记录";
  if (known === total) return `${known} 个样本`;
  return `${known}/${total} 个有效样本`;
}

function formatUpdatedAt(value?: string): string {
  if (!value) return "更新于 --";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新于 --";
  return `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date)}`;
}

function formatStateDetail(data: StatusData, scope: DisplayScope): string {
  if (scope.selected && scope.modelClass && scope.startAt && scope.endAt) {
    const prefix = `${modelLabels[scope.modelClass]} · ${formatRange(scope.startAt, scope.endAt)} · `;
    const sampleCount = typeof scope.sampleCount === "number" ? scope.sampleCount : 0;
    const successCount = typeof scope.successCount === "number" ? scope.successCount : 0;
    if (sampleCount < 5) return `${prefix}${sampleCount} 条轮次`;
    if (typeof scope.availability === "number") {
      return `${prefix}成功轮次 ${successCount}/${sampleCount}，成功率 ${formatPercent(scope.availability)}`;
    }
    return `${prefix}社区轮次观测`;
  }

  const windowText = formatWindowLabel(data.window);
  const sampleCount = Number.isInteger(data.sampleCount) ? data.sampleCount : 0;
  if (data.state === "insufficient_data") return `${windowText} · ${sampleCount} 条轮次`;
  if (typeof data.availability === "number") {
    return `${windowText}成功轮次 ${data.successCount}/${data.sampleCount}，成功率 ${formatPercent(data.availability)}`;
  }
  return `${windowText}社区轮次观测`;
}

function formatWindowLabel(value?: string): string {
  return windowLabels[value || ""] || windowLabels[activeWindow] || activeWindow;
}

function getDisplayScope(data: StatusData): DisplayScope {
  if (selectedTrendBucket) return { selected: true, ...selectedTrendBucket };
  return {
    selected: false,
    sampleCount: data.sampleCount,
    successCount: data.successCount,
    failureCount: data.failureCount,
    availability: data.availability,
    assistantStart: data.assistantStart
  };
}

function getDisplayState(data: StatusData, scope: DisplayScope): ServiceState {
  if (!scope.selected) return normalizeServiceState(data.state);
  const sampleCount = scope.sampleCount ?? 0;
  if (sampleCount < 5 || typeof scope.availability !== "number") return "insufficient_data";
  if (scope.availability >= 0.8) return "available";
  if (scope.availability >= 0.3) return "unstable";
  return "down";
}

function getBucketCounts(bucket: TrendBucket): { total: number; success: number; failure: number } {
  const hasTotal = typeof bucket.total === "number" && Number.isFinite(bucket.total);
  const hasSuccess = typeof bucket.success === "number" && Number.isFinite(bucket.success);
  const hasFailure = typeof bucket.failure === "number" && Number.isFinite(bucket.failure);
  const total = hasTotal ? Math.max(0, Math.trunc(bucket.total as number)) : 0;
  let success = hasSuccess ? Math.max(0, Math.trunc(bucket.success as number)) : 0;
  let failure = hasFailure ? Math.max(0, Math.trunc(bucket.failure as number)) : 0;

  if (hasTotal && !hasSuccess && hasFailure) success = Math.max(0, total - failure);
  if (hasTotal && hasSuccess && !hasFailure) failure = Math.max(0, total - success);

  return {
    total: hasTotal ? total : success + failure,
    success,
    failure
  };
}

function formatBucketTooltip(bucket: TrendBucket): string {
  const { total, success, failure } = getBucketCounts(bucket);
  const lines = [formatRange(bucket.startAt, bucket.endAt)];

  if (total <= 0) {
    lines.push("无数据");
    return lines.join("\n");
  }

  lines.push(`成功 ${success} · 失败 ${failure} · 总轮次 ${total}`);
  lines.push(`成功率 ${formatPercent(total > 0 ? success / total : null)}`);
  lines.push(`首次响应 P50 ${success > 0 ? formatAssistantStart(bucket.assistantStart || undefined, success) : "无成功样本"}`);

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
  if (value === "fable" || value === "opus" || value === "sonnet" || value === "haiku" || value === "gpt-5.5" || value === "unknown") return value;
  return "unknown";
}

function normalizeTargetHostFilter(value: unknown): TargetHostFilter {
  if (typeof value === "string" && targetHostParams.has(value)) return value as TargetHostFilter;
  return "all";
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

function bindTrendSelection(element: HTMLElement, modelClass: ModelClass, bucket: TrendBucket): void {
  element.addEventListener("click", () => {
    selectTrendBucket(modelClass, bucket);
  });
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectTrendBucket(modelClass, bucket);
  });
}

function selectTrendBucket(modelClass: ModelClass, bucket: TrendBucket): void {
  const counts = getBucketCounts(bucket);
  selectedTrendBucket = {
    modelClass,
    bucketIndex: bucket.index,
    startAt: bucket.startAt,
    endAt: bucket.endAt,
    sampleCount: counts.total,
    successCount: counts.success,
    failureCount: counts.failure,
    availability: counts.total > 0 ? counts.success / counts.total : null,
    assistantStart: bucket.assistantStart || null,
    errors: bucket.errors || []
  };
  activeErrorModel = modelClass;
  saveErrorModel(modelClass);
  if (latestStatusData) render(latestStatusData);
  else syncErrorModelTabs();
}

function clearTrendSelection(): void {
  if (!selectedTrendBucket) return;
  selectedTrendBucket = null;
  if (latestStatusData) render(latestStatusData);
  else syncErrorModelTabs();
}

function syncSelectedTrendBucket(data: StatusData): void {
  if (!selectedTrendBucket) return;
  const bucket = findModelStatus(data, selectedTrendBucket.modelClass)?.buckets?.find((item) =>
    item.index === selectedTrendBucket?.bucketIndex &&
    item.startAt === selectedTrendBucket?.startAt &&
    item.endAt === selectedTrendBucket?.endAt
  );
  if (!bucket) {
    selectedTrendBucket = null;
    return;
  }
  const counts = getBucketCounts(bucket);
  selectedTrendBucket = {
    modelClass: selectedTrendBucket.modelClass,
    bucketIndex: bucket.index,
    startAt: bucket.startAt,
    endAt: bucket.endAt,
    sampleCount: counts.total,
    successCount: counts.success,
    failureCount: counts.failure,
    availability: counts.total > 0 ? counts.success / counts.total : null,
    assistantStart: bucket.assistantStart || null,
    errors: bucket.errors || []
  };
}

function isSelectedTrendBucket(modelClass: ModelClass, bucket: TrendBucket): boolean {
  return selectedTrendBucket?.modelClass === modelClass &&
    selectedTrendBucket.bucketIndex === bucket.index &&
    selectedTrendBucket.startAt === bucket.startAt &&
    selectedTrendBucket.endAt === bucket.endAt;
}

function syncErrorModelTabs(data?: StatusData): void {
  const modelClasses = data ? getVisibleModelClasses(data) : [...defaultModelClasses];
  if (!modelClasses.includes(activeErrorModel)) {
    activeErrorModel = modelClasses[0] ?? "fable";
    saveErrorModel(activeErrorModel);
    selectedTrendBucket = null;
  }

  const root = getElement("errorModelTabs");
  root.style.setProperty("--tab-count", String(modelClasses.length));
  root.classList.toggle("fourTabs", modelClasses.length >= 4);
  root.replaceChildren();

  for (const modelClass of modelClasses) {
    const button = document.createElement("button");
    const selected = modelClass === activeErrorModel;
    button.type = "button";
    button.dataset.errorModel = modelClass;
    button.textContent = modelLabels[modelClass];
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.addEventListener("click", () => {
      activeErrorModel = modelClass;
      saveErrorModel(modelClass);
      selectedTrendBucket = null;
      if (latestStatusData) render(latestStatusData);
      else syncErrorModelTabs();
    });
    root.append(button);
  }
}

function buildTrendAxis(buckets: TrendBucket[]): HTMLElement {
  const axis = document.createElement("div");
  axis.className = "trendAxis";
  axis.setAttribute("aria-hidden", "true");
  axis.style.setProperty("--bucket-count", String(Math.max(1, buckets.length)));

  for (const index of getTrendTickIndices(buckets.length)) {
    const bucket = buckets[index];
    if (!bucket) continue;
    const tick = document.createElement("span");
    tick.className = "trendTick";
    if (index === 0) tick.classList.add("first");
    if (index === buckets.length - 1) tick.classList.add("last");
    tick.style.gridColumn = `${index + 1}`;
    tick.textContent = formatTrendTickLabel(index === buckets.length - 1 ? bucket.endAt : bucket.startAt);
    axis.append(tick);
  }

  return axis;
}

function getTrendTickIndices(count: number): number[] {
  if (count <= 0) return [];
  const segmentCount = count >= 24 ? 4 : 3;
  const indices = new Set<number>();
  for (let i = 0; i <= segmentCount; i += 1) indices.add(Math.round((count - 1) * i / segmentCount));
  return [...indices].sort((a, b) => a - b);
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
