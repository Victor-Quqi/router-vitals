import { ASSISTANT_START_BUCKETS, STATUS_ASSISTANT_START_COLUMNS, STATUS_ERROR_COLUMNS, STATUS_MODEL_ORDER, STATUS_STATE_THRESHOLDS, STATUS_WINDOW_SPECS } from "../../shared/policy.mjs";
export function parseStatusWindow(value) {
    return isStatusWindow(value) ? STATUS_WINDOW_SPECS[value].minutes : null;
}
export function getStatusWindowSpec(value) {
    return isStatusWindow(value) ? { ...STATUS_WINDOW_SPECS[value] } : null;
}
export function buildStatusFromRows(rows, windowValue, modelRows = [], nowMinute = Math.floor(Date.now() / 60000), modelErrorDetailRows = []) {
    const spec = getStatusWindowSpec(windowValue);
    const totals = sumRows(rows);
    const total = totals.total_samples;
    const availability = total > 0 ? totals.success_samples / total : null;
    const errors = buildErrorBreakdown(totals.errors, totals.failure_samples, modelErrorDetailRows);
    const state = getState({ total, availability });
    const models = spec ? buildModelTimelines(modelRows, spec, nowMinute, modelErrorDetailRows) : [];
    const modelErrors = buildModelErrorBreakdowns(models, modelErrorDetailRows);
    return {
        window: windowValue,
        generatedAt: new Date().toISOString(),
        state,
        label: labelForState(state, errors),
        sampleCount: total,
        successCount: totals.success_samples,
        failureCount: totals.failure_samples,
        availability,
        assistantStart: buildAssistantStartSummary(totals.assistantStart),
        errors,
        timeline: spec ? buildTimelineMeta(spec, nowMinute) : null,
        models,
        modelErrors,
        meta: {
            unit: "turn",
            availabilityFormula: "successCount / sampleCount",
            assistantStartDefinition: "Time from prompt submit to the first assistant evidence for successful turns; Codex turns use the client-measured time to first token.",
            sampleCountDefinition: "Completed user turns (Claude Code or Codex) observed by the plugin in this window.",
            trendBucketRule: "empty=no samples; success=only successful turns; mixed=successful and failed turns; failure=only failed turns.",
            stateThresholds: { ...STATUS_STATE_THRESHOLDS }
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
function buildModelTimelines(rows, spec, nowMinute, errorRows = []) {
    const startMinute = nowMinute - spec.minutes + 1;
    const models = new Map();
    const assistantStartByBucket = new Map();
    for (const modelClass of STATUS_MODEL_ORDER) {
        getModelTimeline(models, modelClass, spec, startMinute, nowMinute);
    }
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
        const rowAssistantStart = readAssistantStartCounts(row);
        if (shouldIncludeAssistantStartCounts(rowAssistantStart, success)) {
            addAssistantStartCounts(getAssistantStartCounts(assistantStartByBucket, modelClass, bucketIndex), rowAssistantStart);
        }
    }
    attachModelAssistantStarts(models, assistantStartByBucket);
    attachBucketErrors(models, errorRows);
    return [...models.values()]
        .map(finalizeModelTimeline)
        .sort((a, b) => STATUS_MODEL_ORDER.indexOf(a.modelClass) - STATUS_MODEL_ORDER.indexOf(b.modelClass));
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
        assistantStart: null,
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
                state: "empty",
                assistantStart: null,
                errors: []
            };
        })
    };
    models.set(modelClass, model);
    return model;
}
function getAssistantStartCounts(values, modelClass, bucketIndex) {
    const key = `${modelClass}:${bucketIndex}`;
    const current = values.get(key);
    if (current)
        return current;
    const counts = createAssistantStartCounts();
    values.set(key, counts);
    return counts;
}
function attachModelAssistantStarts(models, values) {
    const modelTotals = new Map();
    for (const [key, counts] of values) {
        const [modelClassValue, bucketIndexValue] = key.split(":");
        const modelClass = normalizeModelClass(modelClassValue);
        const bucket = models.get(modelClass)?.buckets[Number(bucketIndexValue)];
        if (!bucket)
            continue;
        const summary = buildAssistantStartSummary(counts);
        bucket.assistantStart = summary.total > 0 ? summary : null;
        let totals = modelTotals.get(modelClass);
        if (!totals) {
            totals = createAssistantStartCounts();
            modelTotals.set(modelClass, totals);
        }
        addAssistantStartCounts(totals, counts);
    }
    for (const [modelClass, counts] of modelTotals) {
        const model = models.get(modelClass);
        if (!model)
            continue;
        const summary = buildAssistantStartSummary(counts);
        model.assistantStart = summary.total > 0 ? summary : null;
    }
}
function attachBucketErrors(models, rows) {
    const grouped = new Map();
    for (const row of rows) {
        const bucketIndex = Number(row.bucket_index);
        if (!Number.isInteger(bucketIndex))
            continue;
        const modelClass = normalizeModelClass(row.model_class);
        const model = models.get(modelClass);
        const bucket = model?.buckets[bucketIndex];
        if (!bucket)
            continue;
        const key = `${modelClass}:${bucketIndex}`;
        const item = getGroupedErrors(grouped, key);
        const type = normalizeErrorType(row.error_type);
        const count = Number(row.count || 0);
        if (count <= 0)
            continue;
        item.counts[type] += count;
        item.rows.push(row);
    }
    for (const [key, item] of grouped) {
        const [modelClass, bucketIndexValue] = key.split(":");
        const bucketIndex = Number(bucketIndexValue);
        const bucket = models.get(normalizeModelClass(modelClass))?.buckets[bucketIndex];
        if (!bucket)
            continue;
        bucket.errors = buildErrorBreakdown(item.counts, bucket.failure, item.rows);
    }
}
function buildModelErrorBreakdowns(models, rows) {
    const grouped = new Map();
    for (const modelClass of STATUS_MODEL_ORDER)
        grouped.set(modelClass, createErrorGroup());
    for (const row of rows) {
        const modelClass = normalizeModelClass(row.model_class);
        const item = grouped.get(modelClass) || createErrorGroup();
        const type = normalizeErrorType(row.error_type);
        const count = Number(row.count || 0);
        if (count <= 0)
            continue;
        item.counts[type] += count;
        item.rows.push(row);
        grouped.set(modelClass, item);
    }
    const failureCounts = new Map(models.map((model) => [model.modelClass, model.failureCount]));
    return Object.fromEntries(STATUS_MODEL_ORDER.map((modelClass) => {
        const item = grouped.get(modelClass) || createErrorGroup();
        return [modelClass, buildErrorBreakdown(item.counts, failureCounts.get(modelClass) || 0, item.rows)];
    }));
}
function getGroupedErrors(grouped, key) {
    const current = grouped.get(key);
    if (current)
        return current;
    const item = createErrorGroup();
    grouped.set(key, item);
    return item;
}
function createErrorGroup() {
    return {
        rows: [],
        counts: Object.fromEntries(STATUS_ERROR_COLUMNS.map(([key]) => [key, 0]))
    };
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
        assistantStart: createAssistantStartCounts(),
        errors: Object.fromEntries(STATUS_ERROR_COLUMNS.map(([key]) => [key, 0]))
    };
    for (const row of rows) {
        totals.total_samples += Number(row.total_samples || 0);
        totals.success_samples += Number(row.success_samples || 0);
        totals.failure_samples += Number(row.failure_samples || 0);
        const rowAssistantStart = readAssistantStartCounts(row);
        const successSamples = Number(row.success_samples || 0);
        if (shouldIncludeAssistantStartCounts(rowAssistantStart, successSamples))
            addAssistantStartCounts(totals.assistantStart, rowAssistantStart);
        for (const [key, column] of STATUS_ERROR_COLUMNS)
            totals.errors[key] += Number(row[column] || 0);
    }
    return totals;
}
function createAssistantStartCounts() {
    return Object.fromEntries(ASSISTANT_START_BUCKETS.map((key) => [key, 0]));
}
function readAssistantStartCounts(row) {
    const counts = createAssistantStartCounts();
    for (const [key, column] of STATUS_ASSISTANT_START_COLUMNS)
        counts[key] = Number(row[column] || 0);
    return counts;
}
function shouldIncludeAssistantStartCounts(counts, successSamples) {
    const total = sumAssistantStartCounts(counts);
    return successSamples > 0 && total > 0 && total <= successSamples;
}
function addAssistantStartCounts(target, counts) {
    for (const key of ASSISTANT_START_BUCKETS)
        target[key] += counts[key] || 0;
}
function sumAssistantStartCounts(counts) {
    return ASSISTANT_START_BUCKETS.reduce((sum, key) => sum + (counts[key] || 0), 0);
}
function buildAssistantStartSummary(counts) {
    const buckets = Object.fromEntries(ASSISTANT_START_BUCKETS.map((key) => [key, counts[key] || 0]));
    const unknown = buckets.unknown || 0;
    const knownBuckets = ASSISTANT_START_BUCKETS.filter((key) => key !== "unknown");
    const known = knownBuckets.reduce((sum, key) => sum + buckets[key], 0);
    let medianBucket = null;
    if (known > 0) {
        const midpoint = Math.ceil(known / 2);
        let cumulative = 0;
        for (const key of knownBuckets) {
            cumulative += buckets[key];
            if (cumulative >= midpoint) {
                medianBucket = key;
                break;
            }
        }
    }
    return {
        total: known + unknown,
        known,
        unknown,
        medianBucket,
        buckets
    };
}
function buildErrorBreakdown(counts, failureCount, detailRows = []) {
    const details = buildErrorDetails(detailRows);
    return STATUS_ERROR_COLUMNS
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
    if (availability < 0.3)
        return "down";
    if (availability < 0.8)
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
    return STATUS_MODEL_ORDER.includes(value) ? value : "unknown";
}
function normalizeErrorType(value) {
    return STATUS_ERROR_COLUMNS.some(([type]) => type === value) ? value : "unknown";
}
function minuteToIso(minute) {
    return new Date(minute * 60000).toISOString();
}
function isStatusWindow(value) {
    return value in STATUS_WINDOW_SPECS;
}
