import {
  ASSISTANT_START_BUCKETS,
  STATUS_ASSISTANT_START_COLUMNS,
  STATUS_ERROR_COLUMNS,
  STATUS_MODEL_ORDER,
  STATUS_STATE_THRESHOLDS,
  STATUS_WINDOW_SPECS,
  type AssistantStartBucket,
  type ErrorType,
  type ModelClass,
  type StatusWindow
} from "../../shared/policy.mjs";

type BucketState = "empty" | "success" | "mixed" | "failure";
type ServiceState = keyof typeof STATUS_STATE_THRESHOLDS;

export interface WindowSpec {
  minutes: number;
  bucketMinutes: number;
  bucketCount: number;
}

export interface AggregateRow {
  minute?: unknown;
  total_samples?: unknown;
  success_samples?: unknown;
  failure_samples?: unknown;
  [key: string]: unknown;
}

export interface ModelAggregateRow {
  minute?: unknown;
  model_class?: unknown;
  total_samples?: unknown;
  success_samples?: unknown;
  failure_samples?: unknown;
  [key: string]: unknown;
}

export interface ErrorDetailRow {
  error_type?: unknown;
  status_code?: unknown;
  error_hint?: unknown;
  count?: unknown;
}

export interface ModelErrorDetailRow extends ErrorDetailRow {
  bucket_index?: unknown;
  model_class?: unknown;
}

interface TimelineMeta {
  bucketMinutes: number;
  bucketCount: number;
  startAt: string;
  endAt: string;
}

export interface TimelineBucket {
  index: number;
  startAt: string;
  endAt: string;
  total: number;
  success: number;
  failure: number;
  state: BucketState;
  assistantStart: AssistantStartSummary | null;
  errors: ErrorBreakdown[];
}

export interface ModelTimeline {
  modelClass: ModelClass;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  availability: number | null;
  state: ServiceState;
  buckets: TimelineBucket[];
}

export interface ErrorBreakdown {
  type: ErrorType;
  count: number;
  ratio: number;
  statusCodes: Array<{ code: number; count: number }>;
  hints: Array<{ text: string; count: number }>;
}

export interface AssistantStartSummary {
  total: number;
  known: number;
  unknown: number;
  medianBucket: AssistantStartBucket | null;
  buckets: Record<AssistantStartBucket, number>;
}

export interface StatusResponse {
  window: string;
  generatedAt: string;
  state: ServiceState;
  label: string;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  availability: number | null;
  assistantStart: AssistantStartSummary;
  errors: ErrorBreakdown[];
  timeline: TimelineMeta | null;
  models: ModelTimeline[];
  modelErrors: Record<ModelClass, ErrorBreakdown[]>;
  meta: {
    unit: "turn";
    availabilityFormula: string;
    assistantStartDefinition: string;
    sampleCountDefinition: string;
    trendBucketRule: string;
    stateThresholds: Record<ServiceState, string>;
  };
}

interface Totals {
  total_samples: number;
  success_samples: number;
  failure_samples: number;
  assistantStart: Record<AssistantStartBucket, number>;
  errors: Record<ErrorType, number>;
}

interface ErrorDetailAccumulator {
  statusCounts: Map<number, number>;
  hintCounts: Map<string, number>;
}

interface ErrorDetails {
  statusCodes: Array<{ code: number; count: number }>;
  hints: Array<{ text: string; count: number }>;
}

export function parseStatusWindow(value: string): number | null {
  return isStatusWindow(value) ? STATUS_WINDOW_SPECS[value].minutes : null;
}

export function getStatusWindowSpec(value: string): WindowSpec | null {
  return isStatusWindow(value) ? { ...STATUS_WINDOW_SPECS[value] } : null;
}

export function buildStatusFromRows(
  rows: AggregateRow[],
  windowValue: string,
  modelRows: ModelAggregateRow[] = [],
  nowMinute = Math.floor(Date.now() / 60000),
  modelErrorDetailRows: ModelErrorDetailRow[] = []
): StatusResponse {
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

function buildTimelineMeta(spec: WindowSpec, nowMinute: number): TimelineMeta {
  const startMinute = nowMinute - spec.minutes + 1;
  return {
    bucketMinutes: spec.bucketMinutes,
    bucketCount: spec.bucketCount,
    startAt: minuteToIso(startMinute),
    endAt: minuteToIso(nowMinute)
  };
}

function buildModelTimelines(
  rows: ModelAggregateRow[],
  spec: WindowSpec,
  nowMinute: number,
  errorRows: ModelErrorDetailRow[] = []
): ModelTimeline[] {
  const startMinute = nowMinute - spec.minutes + 1;
  const models = new Map<ModelClass, ModelTimeline>();
  const assistantStartByBucket = new Map<string, Record<AssistantStartBucket, number>>();
  for (const modelClass of STATUS_MODEL_ORDER) {
    getModelTimeline(models, modelClass, spec, startMinute, nowMinute);
  }

  for (const row of rows) {
    const minute = Number(row.minute);
    if (!Number.isFinite(minute)) continue;
    const bucketIndex = Math.floor((minute - startMinute) / spec.bucketMinutes);
    if (bucketIndex < 0 || bucketIndex >= spec.bucketCount) continue;

    const modelClass = normalizeModelClass(row.model_class);
    const model = getModelTimeline(models, modelClass, spec, startMinute, nowMinute);
    const total = Number(row.total_samples || 0);
    const success = Number(row.success_samples || 0);
    const failure = Number(row.failure_samples || 0);
    const bucket = model.buckets[bucketIndex];
    if (!bucket) continue;

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

function getModelTimeline(
  models: Map<ModelClass, ModelTimeline>,
  modelClass: ModelClass,
  spec: WindowSpec,
  startMinute: number,
  nowMinute: number
): ModelTimeline {
  const current = models.get(modelClass);
  if (current) return current;

  const model: ModelTimeline = {
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
        state: "empty" as const,
        assistantStart: null,
        errors: []
      };
    })
  };

  models.set(modelClass, model);
  return model;
}

function getAssistantStartCounts(
  values: Map<string, Record<AssistantStartBucket, number>>,
  modelClass: ModelClass,
  bucketIndex: number
): Record<AssistantStartBucket, number> {
  const key = `${modelClass}:${bucketIndex}`;
  const current = values.get(key);
  if (current) return current;
  const counts = createAssistantStartCounts();
  values.set(key, counts);
  return counts;
}

function attachModelAssistantStarts(
  models: Map<ModelClass, ModelTimeline>,
  values: Map<string, Record<AssistantStartBucket, number>>
): void {
  for (const [key, counts] of values) {
    const [modelClassValue, bucketIndexValue] = key.split(":");
    const bucket = models.get(normalizeModelClass(modelClassValue))?.buckets[Number(bucketIndexValue)];
    if (!bucket) continue;
    const summary = buildAssistantStartSummary(counts);
    bucket.assistantStart = summary.total > 0 ? summary : null;
  }
}

function attachBucketErrors(models: Map<ModelClass, ModelTimeline>, rows: ModelErrorDetailRow[]): void {
  const grouped = new Map<string, { rows: ModelErrorDetailRow[]; counts: Record<ErrorType, number> }>();

  for (const row of rows) {
    const bucketIndex = Number(row.bucket_index);
    if (!Number.isInteger(bucketIndex)) continue;
    const modelClass = normalizeModelClass(row.model_class);
    const model = models.get(modelClass);
    const bucket = model?.buckets[bucketIndex];
    if (!bucket) continue;

    const key = `${modelClass}:${bucketIndex}`;
    const item = getGroupedErrors(grouped, key);
    const type = normalizeErrorType(row.error_type);
    const count = Number(row.count || 0);
    if (count <= 0) continue;
    item.counts[type] += count;
    item.rows.push(row);
  }

  for (const [key, item] of grouped) {
    const [modelClass, bucketIndexValue] = key.split(":");
    const bucketIndex = Number(bucketIndexValue);
    const bucket = models.get(normalizeModelClass(modelClass))?.buckets[bucketIndex];
    if (!bucket) continue;
    bucket.errors = buildErrorBreakdown(item.counts, bucket.failure, item.rows);
  }
}

function buildModelErrorBreakdowns(
  models: ModelTimeline[],
  rows: ModelErrorDetailRow[]
): Record<ModelClass, ErrorBreakdown[]> {
  const grouped = new Map<ModelClass, { rows: ModelErrorDetailRow[]; counts: Record<ErrorType, number> }>();
  for (const modelClass of STATUS_MODEL_ORDER) grouped.set(modelClass, createErrorGroup());

  for (const row of rows) {
    const modelClass = normalizeModelClass(row.model_class);
    const item = grouped.get(modelClass) || createErrorGroup();
    const type = normalizeErrorType(row.error_type);
    const count = Number(row.count || 0);
    if (count <= 0) continue;
    item.counts[type] += count;
    item.rows.push(row);
    grouped.set(modelClass, item);
  }

  const failureCounts = new Map(models.map((model) => [model.modelClass, model.failureCount]));
  return Object.fromEntries(STATUS_MODEL_ORDER.map((modelClass) => {
    const item = grouped.get(modelClass) || createErrorGroup();
    return [modelClass, buildErrorBreakdown(item.counts, failureCounts.get(modelClass) || 0, item.rows)];
  })) as Record<ModelClass, ErrorBreakdown[]>;
}

function getGroupedErrors(
  grouped: Map<string, { rows: ModelErrorDetailRow[]; counts: Record<ErrorType, number> }>,
  key: string
): { rows: ModelErrorDetailRow[]; counts: Record<ErrorType, number> } {
  const current = grouped.get(key);
  if (current) return current;
  const item = createErrorGroup();
  grouped.set(key, item);
  return item;
}

function createErrorGroup(): { rows: ModelErrorDetailRow[]; counts: Record<ErrorType, number> } {
  return {
    rows: [],
    counts: Object.fromEntries(STATUS_ERROR_COLUMNS.map(([key]) => [key, 0])) as Record<ErrorType, number>
  };
}

function finalizeModelTimeline(model: ModelTimeline): ModelTimeline {
  model.availability = model.sampleCount > 0 ? model.successCount / model.sampleCount : null;
  model.state = getState({ total: model.sampleCount, availability: model.availability });
  model.buckets = model.buckets.map((bucket) => ({
    ...bucket,
    state: getBucketState(bucket)
  }));
  return model;
}

function sumRows(rows: AggregateRow[]): Totals {
  const totals = {
    total_samples: 0,
    success_samples: 0,
    failure_samples: 0,
    assistantStart: createAssistantStartCounts(),
    errors: Object.fromEntries(STATUS_ERROR_COLUMNS.map(([key]) => [key, 0]))
  } as Totals;

  for (const row of rows) {
    totals.total_samples += Number(row.total_samples || 0);
    totals.success_samples += Number(row.success_samples || 0);
    totals.failure_samples += Number(row.failure_samples || 0);
    const rowAssistantStart = readAssistantStartCounts(row);
    const successSamples = Number(row.success_samples || 0);
    if (shouldIncludeAssistantStartCounts(rowAssistantStart, successSamples)) addAssistantStartCounts(totals.assistantStart, rowAssistantStart);
    for (const [key, column] of STATUS_ERROR_COLUMNS) totals.errors[key] += Number(row[column] || 0);
  }

  return totals;
}

function createAssistantStartCounts(): Record<AssistantStartBucket, number> {
  return Object.fromEntries(ASSISTANT_START_BUCKETS.map((key) => [key, 0])) as Record<AssistantStartBucket, number>;
}

function readAssistantStartCounts(row: Record<string, unknown>): Record<AssistantStartBucket, number> {
  const counts = createAssistantStartCounts();
  for (const [key, column] of STATUS_ASSISTANT_START_COLUMNS) counts[key] = Number(row[column] || 0);
  return counts;
}

function shouldIncludeAssistantStartCounts(counts: Record<AssistantStartBucket, number>, successSamples: number): boolean {
  const total = sumAssistantStartCounts(counts);
  return successSamples > 0 && total > 0 && total <= successSamples;
}

function addAssistantStartCounts(
  target: Record<AssistantStartBucket, number>,
  counts: Record<AssistantStartBucket, number>
): void {
  for (const key of ASSISTANT_START_BUCKETS) target[key] += counts[key] || 0;
}

function sumAssistantStartCounts(counts: Record<AssistantStartBucket, number>): number {
  return ASSISTANT_START_BUCKETS.reduce((sum, key) => sum + (counts[key] || 0), 0);
}

function buildAssistantStartSummary(counts: Record<AssistantStartBucket, number>): AssistantStartSummary {
  const buckets = Object.fromEntries(ASSISTANT_START_BUCKETS.map((key) => [key, counts[key] || 0])) as Record<AssistantStartBucket, number>;
  const unknown = buckets.unknown || 0;
  const knownBuckets = ASSISTANT_START_BUCKETS.filter((key) => key !== "unknown");
  const known = knownBuckets.reduce((sum, key) => sum + buckets[key], 0);
  let medianBucket: AssistantStartBucket | null = null;

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

function buildErrorBreakdown(
  counts: Record<ErrorType, number>,
  failureCount: number,
  detailRows: ErrorDetailRow[] = []
): ErrorBreakdown[] {
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

function buildErrorDetails(rows: ErrorDetailRow[]): Map<ErrorType, ErrorDetails> {
  const accumulators = new Map<ErrorType, ErrorDetailAccumulator>();

  for (const row of rows) {
    const type = normalizeErrorType(row.error_type);
    const count = Number(row.count || 0);
    if (count <= 0) continue;
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

  const details = new Map<ErrorType, ErrorDetails>();
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

function getErrorDetail(details: Map<ErrorType, ErrorDetailAccumulator>, type: ErrorType): ErrorDetailAccumulator {
  const current = details.get(type);
  if (current) return current;
  const item = {
    statusCounts: new Map(),
    hintCounts: new Map()
  };
  details.set(type, item);
  return item;
}

function getState({ total, availability }: { total: number; availability: number | null }): ServiceState {
  if (total < 5 || availability === null) return "insufficient_data";
  if (availability < 0.5) return "down";
  if (availability < 0.9) return "unstable";
  return "available";
}

function getBucketState(bucket: TimelineBucket): BucketState {
  if (bucket.total <= 0) return "empty";
  if (bucket.success > 0 && bucket.failure === 0) return "success";
  if (bucket.success > 0 && bucket.failure > 0) return "mixed";
  if (bucket.success === 0 && bucket.failure > 0) return "failure";
  return "empty";
}

function labelForState(state: ServiceState, errors: ErrorBreakdown[]): string {
  const primaryError = errors[0];
  if (state === "unstable" && primaryError) {
    return primaryError.type === "unknown" ? "失败偏高" : `${primaryError.type} 偏高`;
  }
  if (state === "down") return "不可用";
  if (state === "available") return "可用";
  return "样本不足，暂不判断可用状态";
}

function normalizeModelClass(value: unknown): ModelClass {
  return STATUS_MODEL_ORDER.includes(value as ModelClass) ? value as ModelClass : "unknown";
}

function normalizeErrorType(value: unknown): ErrorType {
  return STATUS_ERROR_COLUMNS.some(([type]) => type === value) ? value as ErrorType : "unknown";
}

function minuteToIso(minute: number): string {
  return new Date(minute * 60000).toISOString();
}

function isStatusWindow(value: string): value is StatusWindow {
  return value in STATUS_WINDOW_SPECS;
}
