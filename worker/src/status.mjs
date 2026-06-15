const ERROR_ORDER = Object.freeze([
    ["server_error", "err_server_error"],
    ["rate_limited", "err_rate_limited"],
    ["network_error", "err_network_error"],
    ["auth_error", "err_auth_error"],
    ["timeout", "err_timeout"],
    ["unknown", "err_unknown"]
]);
const MODEL_ORDER = Object.freeze(["haiku", "sonnet", "opus", "unknown"]);
const WINDOW_SPECS = Object.freeze({
    "5m": { minutes: 5, bucketMinutes: 1, bucketCount: 5 },
    "15m": { minutes: 15, bucketMinutes: 1, bucketCount: 15 },
    "60m": { minutes: 60, bucketMinutes: 5, bucketCount: 12 },
    "90m": { minutes: 90, bucketMinutes: 5, bucketCount: 18 },
    "24h": { minutes: 24 * 60, bucketMinutes: 60, bucketCount: 24 },
    "7d": { minutes: 7 * 24 * 60, bucketMinutes: 6 * 60, bucketCount: 28 },
    "30d": { minutes: 30 * 24 * 60, bucketMinutes: 24 * 60, bucketCount: 30 }
});
export function parseStatusWindow(value) {
    return isStatusWindow(value) ? WINDOW_SPECS[value].minutes : null;
}
export function getStatusWindowSpec(value) {
    return isStatusWindow(value) ? { ...WINDOW_SPECS[value] } : null;
}
export function buildStatusFromRows(rows, windowValue, modelRows = [], nowMinute = Math.floor(Date.now() / 60000), errorDetailRows = []) {
    const spec = getStatusWindowSpec(windowValue);
    const totals = sumRows(rows);
    const total = totals.total_samples;
    const availability = total > 0 ? totals.success_samples / total : null;
    const errors = buildErrorBreakdown(totals.errors, totals.failure_samples, errorDetailRows);
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
        timeline: spec ? buildTimelineMeta(spec, nowMinute) : null,
        models: spec ? buildModelTimelines(modelRows, spec, nowMinute) : [],
        meta: {
            unit: "turn",
            availabilityFormula: "successCount / sampleCount",
            sampleCountDefinition: "Completed Claude Code user turns observed by the plugin in this window.",
            trendBucketRule: "empty=no samples; success=only successful turns; mixed=successful and failed turns; failure=only failed turns.",
            stateThresholds: {
                insufficient_data: "sampleCount < 5",
                down: "availability < 50%",
                unstable: "50% <= availability < 90%",
                available: "availability >= 90%"
            }
        }
    };
}
function buildTimelineMeta(spec, nowMinute) {
    const startMinute = nowMinute - spec.minutes + 1;
    return {
        bucketMinutes: spec.bucketMinutes,
        bucketCount: spec.bucketCount,
        startAt: minuteToIso(startMinute),
        endAt: minuteToIso(nowMinute)
    };
}
function buildModelTimelines(rows, spec, nowMinute) {
    const startMinute = nowMinute - spec.minutes + 1;
    const models = new Map();
    for (const modelClass of MODEL_ORDER)
        getModelTimeline(models, modelClass, spec, startMinute, nowMinute);
    for (const row of rows) {
        const minute = Number(row.minute);
        if (!Number.isFinite(minute))
            continue;
        const bucketIndex = Math.floor((minute - startMinute) / spec.bucketMinutes);
        if (bucketIndex < 0 || bucketIndex >= spec.bucketCount)
            continue;
        const modelClass = normalizeModelClass(row.model_class);
        const model = getModelTimeline(models, modelClass, spec, startMinute, nowMinute);
        const total = Number(row.total_samples || 0);
        const success = Number(row.success_samples || 0);
        const failure = Number(row.failure_samples || 0);
        const bucket = model.buckets[bucketIndex];
        if (!bucket)
            continue;
        bucket.total += total;
        bucket.success += success;
        bucket.failure += failure;
        model.sampleCount += total;
        model.successCount += success;
        model.failureCount += failure;
    }
    return [...models.values()]
        .map(finalizeModelTimeline)
        .sort((a, b) => MODEL_ORDER.indexOf(a.modelClass) - MODEL_ORDER.indexOf(b.modelClass));
}
function getModelTimeline(models, modelClass, spec, startMinute, nowMinute) {
    const current = models.get(modelClass);
    if (current)
        return current;
    const model = {
        modelClass,
        sampleCount: 0,
        successCount: 0,
        failureCount: 0,
        availability: null,
        state: "insufficient_data",
        buckets: Array.from({ length: spec.bucketCount }, (_, index) => {
            const bucketStart = startMinute + index * spec.bucketMinutes;
            const bucketEnd = Math.min(bucketStart + spec.bucketMinutes - 1, nowMinute);
            return {
                index,
                startAt: minuteToIso(bucketStart),
                endAt: minuteToIso(bucketEnd),
                total: 0,
                success: 0,
                failure: 0,
                state: "empty"
            };
        })
    };
    models.set(modelClass, model);
    return model;
}
function finalizeModelTimeline(model) {
    model.availability = model.sampleCount > 0 ? model.successCount / model.sampleCount : null;
    model.state = getState({ total: model.sampleCount, availability: model.availability });
    model.buckets = model.buckets.map((bucket) => ({
        ...bucket,
        state: getBucketState(bucket)
    }));
    return model;
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
        for (const [key, column] of ERROR_ORDER)
            totals.errors[key] += Number(row[column] || 0);
    }
    return totals;
}
function buildErrorBreakdown(counts, failureCount, detailRows = []) {
    const details = buildErrorDetails(detailRows);
    return ERROR_ORDER
        .map(([type]) => ({
        type,
        count: counts[type] || 0,
        ratio: failureCount > 0 ? (counts[type] || 0) / failureCount : 0,
        statusCodes: details.get(type)?.statusCodes || [],
        hints: details.get(type)?.hints || []
    }))
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count);
}
function buildErrorDetails(rows) {
    const accumulators = new Map();
    for (const row of rows) {
        const type = normalizeErrorType(row.error_type);
        const count = Number(row.count || 0);
        if (count <= 0)
            continue;
        const item = getErrorDetail(accumulators, type);
        const statusCode = Number(row.status_code);
        if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
            item.statusCounts.set(statusCode, (item.statusCounts.get(statusCode) || 0) + count);
        }
        if (typeof row.error_hint === "string" && row.error_hint.trim()) {
            const hint = row.error_hint.trim();
            item.hintCounts.set(hint, (item.hintCounts.get(hint) || 0) + count);
        }
    }
    const details = new Map();
    for (const [type, item] of accumulators) {
        details.set(type, {
            statusCodes: [...item.statusCounts.entries()]
                .map(([code, count]) => ({ code, count }))
                .sort((a, b) => b.count - a.count || a.code - b.code)
                .slice(0, 4),
            hints: [...item.hintCounts.entries()]
                .map(([text, count]) => ({ text, count }))
                .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
                .slice(0, 3)
        });
    }
    return details;
}
function getErrorDetail(details, type) {
    const current = details.get(type);
    if (current)
        return current;
    const item = {
        statusCounts: new Map(),
        hintCounts: new Map()
    };
    details.set(type, item);
    return item;
}
function getState({ total, availability }) {
    if (total < 5 || availability === null)
        return "insufficient_data";
    if (availability < 0.5)
        return "down";
    if (availability < 0.9)
        return "unstable";
    return "available";
}
function getBucketState(bucket) {
    if (bucket.total <= 0)
        return "empty";
    if (bucket.success > 0 && bucket.failure === 0)
        return "success";
    if (bucket.success > 0 && bucket.failure > 0)
        return "mixed";
    if (bucket.success === 0 && bucket.failure > 0)
        return "failure";
    return "empty";
}
function labelForState(state, errors) {
    const primaryError = errors[0];
    if (state === "unstable" && primaryError) {
        return primaryError.type === "unknown" ? "失败偏高" : `${primaryError.type} 偏高`;
    }
    if (state === "down")
        return "不可用";
    if (state === "available")
        return "可用";
    return "样本不足，暂不判断可用状态";
}
function normalizeModelClass(value) {
    return MODEL_ORDER.includes(value) ? value : "unknown";
}
function normalizeErrorType(value) {
    return ERROR_ORDER.some(([type]) => type === value) ? value : "unknown";
}
function minuteToIso(minute) {
    return new Date(minute * 60000).toISOString();
}
function isStatusWindow(value) {
    return value in WINDOW_SPECS;
}
