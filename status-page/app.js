const API_BASE = window.ANYROUTER_STATUS_API_BASE || window.location.origin;
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
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    unknown: "Unknown"
};
const assistantStartLabels = {
    lt_3s: "<3s",
    "3_10s": "3-10s",
    "10_30s": "10-30s",
    "30_60s": "30-60s",
    gt_60s: ">60s",
    unknown: "--"
};
let activeWindow = "60m";
let activeErrorModel = "opus";
let activeTargetHost = "all";
let latestStatusData = null;
const openErrorKeys = new Set();
const autoRefreshWindows = new Set(["60m", "24h"]);
const autoRefreshMs = 30000;
const themeStorageKey = "router-vitals-theme";
const themeModes = ["system", "light", "dark"];
const themeLabels = {
    system: "主题：跟随系统",
    light: "主题：浅色",
    dark: "主题：深色"
};
let autoRefreshTimer;
let autoRefreshEnabled = false;
let loadSequence = 0;
let manualRefreshTimer;
const targetHostParams = {
    main: "anyrouter.top",
    optimized: "a-ocnfniawgw.cn-shanghai.fcapp.run"
};
const refreshButton = getElement("refreshButton");
const themeButton = getElement("themeButton");
const autoRefreshControl = getElement("autoRefreshControl");
const autoRefreshToggle = getElement("autoRefreshToggle");
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
    if (activeThemeMode === "system")
        applyTheme(activeThemeMode);
});
for (const element of document.querySelectorAll("[data-window]")) {
    const button = element;
    button.addEventListener("click", () => {
        if (!button.dataset.window)
            return;
        activeWindow = button.dataset.window;
        document.querySelectorAll("[data-window]").forEach((item) => item.classList.toggle("active", item === button));
        syncRefreshControls();
        void loadStatus();
    });
}
for (const element of document.querySelectorAll("[data-error-model]")) {
    const button = element;
    button.addEventListener("click", () => {
        const model = normalizeModelClass(button.dataset.errorModel);
        activeErrorModel = model;
        document.querySelectorAll("[data-error-model]").forEach((item) => item.classList.toggle("active", item === button));
        if (latestStatusData)
            renderErrorsForModel(latestStatusData);
    });
}
refreshButton.addEventListener("click", () => {
    playManualRefreshSpin();
    void loadStatus({ bypassCache: true });
});
for (const element of document.querySelectorAll("[data-target-host]")) {
    const button = element;
    button.addEventListener("click", () => {
        activeTargetHost = normalizeTargetHostFilter(button.dataset.targetHost);
        document.querySelectorAll("[data-target-host]").forEach((item) => item.classList.toggle("active", item === button));
        openErrorKeys.clear();
        void loadStatus();
    });
}
autoRefreshToggle.addEventListener("change", () => {
    autoRefreshEnabled = autoRefreshToggle.checked;
    syncRefreshControls();
});
syncRefreshControls();
void loadStatus();
async function loadStatus(options = {}) {
    const sequence = ++loadSequence;
    const requestedWindow = activeWindow;
    refreshButton.disabled = true;
    try {
        const params = new URLSearchParams({ window: requestedWindow });
        if (activeTargetHost !== "all")
            params.set("targetHost", targetHostParams[activeTargetHost]);
        if (options.bypassCache)
            params.set("refresh", "1");
        const response = await fetch(`${API_BASE.replace(/\/+$/, "")}/v1/status?${params}`, {
            cache: options.bypassCache ? "no-store" : "default",
            headers: { accept: "application/json" }
        });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (sequence === loadSequence)
            render(data);
    }
    catch {
        if (sequence === loadSequence)
            renderUnavailable();
    }
    finally {
        if (sequence === loadSequence)
            refreshButton.disabled = false;
    }
}
function syncRefreshControls() {
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
function playManualRefreshSpin() {
    if (manualRefreshTimer !== undefined)
        window.clearTimeout(manualRefreshTimer);
    refreshButton.classList.remove("manualSpin");
    void refreshButton.offsetWidth;
    refreshButton.classList.add("manualSpin");
    manualRefreshTimer = window.setTimeout(() => {
        refreshButton.classList.remove("manualSpin");
        manualRefreshTimer = undefined;
    }, 700);
}
function readThemeMode() {
    try {
        const value = localStorage.getItem(themeStorageKey);
        if (value === "light" || value === "dark")
            return value;
    }
    catch {
        return "system";
    }
    return "system";
}
function saveThemeMode(mode) {
    try {
        if (mode === "system")
            localStorage.removeItem(themeStorageKey);
        else
            localStorage.setItem(themeStorageKey, mode);
    }
    catch {
        return;
    }
}
function applyTheme(mode) {
    const resolved = mode === "system" ? (systemThemeQuery.matches ? "light" : "dark") : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    themeButton.dataset.themeMode = mode;
    themeButton.setAttribute("aria-label", themeLabels[mode]);
    themeButton.title = themeLabels[mode];
}
function render(data) {
    latestStatusData = data;
    const state = normalizeServiceState(data.state);
    setText("state", labels[state] || "状态暂缺");
    setText("stateDetail", formatStateDetail(data));
    setText("updatedAt", formatUpdatedAt(data.generatedAt));
    setText("availability", formatPercent(data.availability));
    setText("sampleCount", String(data.sampleCount ?? "--"));
    setText("failureCountMetric", String(data.failureCount ?? "--"));
    setText("availabilityMath", formatAvailabilityMath(data));
    setText("assistantStart", formatAssistantStart(data.assistantStart));
    setText("assistantStartDetail", formatAssistantStartDetail(data.assistantStart));
    const stateNode = getElement("state");
    stateNode.className = `state ${state}`;
    renderModelTable(data.models || [], data.timeline);
    renderErrorsForModel(data);
}
function renderModelTable(models, timeline) {
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
function buildEmptyModels(timeline) {
    if (!timeline?.bucketCount)
        return [];
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
function renderErrorsForModel(data) {
    const model = findModelStatus(data, activeErrorModel);
    const errors = data.modelErrors?.[activeErrorModel] || [];
    setText("failureCount", `${formatWindowLabel(data.window)} · 失败轮次 ${model?.failureCount ?? 0}`);
    renderErrors(errors);
}
function renderErrors(errors) {
    const root = getElement("errors");
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
            if (nextExpanded)
                openErrorKeys.add(errorKey);
            else
                openErrorKeys.delete(errorKey);
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
    }
    else {
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
    if (!Array.isArray(statusCodes) || statusCodes.length === 0)
        return "";
    return ` (${statusCodes.slice(0, 2).map((item) => item.code).join("/")})`;
}
function renderUnavailable() {
    latestStatusData = null;
    setText("state", "状态暂缺");
    setText("stateDetail", "API 暂时没有返回可用数据");
    setText("updatedAt", "更新于 --");
    for (const id of ["availability", "sampleCount", "failureCountMetric", "assistantStart"])
        setText(id, "--");
    setText("failureCount", formatWindowLabel(activeWindow));
    setText("availabilityMath", "--");
    setText("assistantStartDetail", "--");
    getElement("state").className = "state insufficient_data";
    renderModelTable([], null);
    renderErrors([]);
}
function setText(id, value) {
    getElement(id).textContent = value;
}
function getElement(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`missing element: ${id}`);
    return element;
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
    if (typeof data.successCount !== "number" || typeof data.sampleCount !== "number")
        return "--";
    if (data.sampleCount === 0)
        return "0 / 0";
    return `${data.successCount} / ${data.sampleCount}`;
}
function formatAssistantStart(value) {
    const bucket = value?.medianBucket;
    return bucket ? assistantStartLabels[bucket] : "--";
}
function formatAssistantStartDetail(value) {
    const known = Number(value?.known ?? 0);
    const total = Number(value?.total ?? 0);
    if (known <= 0)
        return "暂无已知记录";
    if (known === total)
        return `${known} 个样本`;
    return `${known}/${total} 个有效样本`;
}
function formatUpdatedAt(value) {
    if (!value)
        return "更新于 --";
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return "更新于 --";
    return `更新于 ${new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(date)}`;
}
function formatStateDetail(data) {
    const windowText = formatWindowLabel(data.window);
    const sampleCount = Number.isInteger(data.sampleCount) ? data.sampleCount : 0;
    if (data.state === "insufficient_data")
        return `${windowText}完成轮次 ${sampleCount} 条，暂不判断可用状态`;
    if (typeof data.availability === "number") {
        return `${windowText}成功轮次 ${data.successCount}/${data.sampleCount}，成功率 ${formatPercent(data.availability)}`;
    }
    return `${windowText}社区轮次观测`;
}
function formatWindowLabel(value) {
    return windowLabels[value || ""] || windowLabels[activeWindow] || activeWindow;
}
function formatBucketTooltip(bucket) {
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
    lines.push(`首次响应 P50 ${formatAssistantStart(bucket.assistantStart || undefined)}`);
    if (failure > 0) {
        const primaryError = bucket.errors?.[0];
        lines.push(primaryError ? `主要错误：${formatPrimaryError(primaryError)}` : "主要错误：暂无明细");
    }
    return lines.join("\n");
}
function formatPrimaryError(error) {
    const meta = errorLabels[error.type || "unknown"] || { title: "未识别错误", detail: "" };
    const statusCode = error.statusCodes?.[0]?.code;
    const count = error.count ?? 0;
    const parts = [meta.title];
    if (statusCode)
        parts.push(`HTTP ${statusCode}`);
    if (count > 0)
        parts.push(`${count} 次`);
    return parts.join(" · ");
}
function normalizeServiceState(value) {
    if (value === "available" || value === "unstable" || value === "down" || value === "insufficient_data")
        return value;
    return "insufficient_data";
}
function normalizeModelClass(value) {
    if (value === "opus" || value === "sonnet" || value === "haiku" || value === "unknown")
        return value;
    return "unknown";
}
function normalizeTargetHostFilter(value) {
    if (value === "main" || value === "optimized")
        return value;
    return "all";
}
function findModelStatus(data, modelClass) {
    return (data.models || []).find((model) => model.modelClass === modelClass);
}
function bindTrendTooltip(element, text) {
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
function showTrendTooltip(text) {
    trendTooltip.textContent = text;
    trendTooltip.classList.add("visible");
}
function hideTrendTooltip() {
    trendTooltip.classList.remove("visible");
}
function positionTrendTooltip(clientX, clientY) {
    const margin = 12;
    const x = Math.min(window.innerWidth - margin, Math.max(margin, clientX));
    const y = Math.min(window.innerHeight - margin, Math.max(margin, clientY));
    trendTooltip.style.left = `${x}px`;
    trendTooltip.style.top = `${y}px`;
}
export {};
