#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { loadRemoteConfig } from "./lib/config.mjs";
import { appendHookDebugRecord } from "./lib/debug.mjs";
import {
  PLUGIN_VERSION,
  bucketAssistantStart,
  classifyError,
  classifyModel,
  createErrorHint,
  createTimeBucket,
  extractErrorStatusCode,
  hashLocalSessionId,
  matchTargetBaseUrl,
  normalizeTargetHost,
  pickSampleRate,
  shouldSample,
  validateReportPayload,
  type ModelClass,
  type RemoteConfig,
  type ReportPayload
} from "./lib/policy.mjs";
import {
  getDailyAnonymousId,
  hasReachedDailyReportLimit,
  incrementContribution,
  loadState,
  recordPluginUpdateReminder,
  saveState,
  shouldRemindPluginUpdate,
  type PluginState,
  type TurnState
} from "./lib/state.mjs";

const eventName = process.argv[2] || "";
const TRANSCRIPT_MODEL_LOOKBACK_BYTES = 256 * 1024;
type HookInput = Record<string, any>;

interface TranscriptInspection {
  firstAssistantAtMs: number | null;
  modelClass: ModelClass;
  modelObservations: TranscriptModelObservation[];
}

interface PromptTranscriptInspection {
  inspected: boolean;
  modelClass: ModelClass;
  modelSetOutputs: ModelSetOutputObservation[];
  hasUnparsedModelSetOutput: boolean;
}

interface ModelCandidateObservation {
  path: string;
  value: string;
  modelClass: ModelClass;
}

interface ModelSetOutputObservation {
  timestampMs: number | null;
  modelClass: ModelClass;
  hasAnsi: boolean;
  textPreview: string;
}

interface TranscriptModelObservation {
  timestampMs: number | null;
  recordType: string | null;
  modelClass: ModelClass;
  candidates: ModelCandidateObservation[];
}

interface ModelResolution {
  modelClass: ModelClass;
  source: "direct_input" | "turn_transcript" | "fallback" | "unknown";
  directInputModelClass: ModelClass;
  transcriptModelClass: ModelClass;
  fallbackModelClasses: ModelClass[];
}

interface PromptStartDebug {
  targetMatched: boolean;
  transcriptStartOffset: number | null;
  sessionBefore: ReturnType<typeof summarizeTurnState>;
  promptModelClass: ModelClass;
  promptSource: "direct_input" | "prompt_transcript" | "unparsed_model_set_output" | "session" | "unknown";
  directInputModelClass: ModelClass;
  promptTranscript: PromptTranscriptInspection;
  pendingAfter: ReturnType<typeof summarizeTurnState>;
  sessionAfter: ReturnType<typeof summarizeTurnState>;
}

interface CompletionDebug {
  pending: ReturnType<typeof summarizeTurnState>;
  skipped: string | null;
  transcript?: TranscriptInspection;
  modelResolution?: ModelResolution;
  payload?: Record<string, unknown>;
  posted?: boolean;
  updateReminder?: {
    latestPluginVersion: string;
    emitted: boolean;
  };
}

main().catch(() => {
  process.exit(0);
});

async function main() {
  const input = await readHookInput();
  const state = await loadState();
  const sessionKey = hashLocalSessionId(input.session_id);
  await writeHookDebug(sessionKey, "received", {
    input: summarizeHookInput(input),
    sessionBefore: summarizeTurnState(state.sessions[sessionKey]),
    pendingBefore: summarizeTurnState(state.pending[sessionKey])
  });

  if (eventName === "SessionStart") {
    const modelClass = recordSessionStart(state, sessionKey, input);
    await writeHookDebug(sessionKey, "session_start", {
      modelClass,
      sessionAfter: summarizeTurnState(state.sessions[sessionKey])
    });
    await saveState(state);
    return;
  }

  if (eventName === "SessionEnd") {
    delete state.sessions[sessionKey];
    await writeHookDebug(sessionKey, "session_end", {
      sessionAfter: summarizeTurnState(state.sessions[sessionKey])
    });
    await saveState(state);
    return;
  }

  if (eventName === "UserPromptSubmit") {
    const debug = await recordPromptStart(state, sessionKey, input);
    await writeHookDebug(sessionKey, "prompt_start", debug as unknown as Record<string, unknown>);
    await saveState(state);
    return;
  }

  if (eventName === "Stop" || eventName === "StopFailure") {
    const config = await loadRemoteConfig();
    const updateReminderMessage = createPluginUpdateReminderMessage(state, config);
    const debug = await reportCompletion({ eventName, input, state, config, sessionKey });
    if (updateReminderMessage) {
      debug.updateReminder = {
        latestPluginVersion: config.latestPluginVersion,
        emitted: true
      };
    }
    await writeHookDebug(sessionKey, "completion", debug as unknown as Record<string, unknown>);
    await saveState(state);
    if (updateReminderMessage) writeHookSystemMessage(updateReminderMessage);
  }
}

async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function recordSessionStart(state: PluginState, sessionKey: string, input: HookInput): ModelClass {
  const modelClass = classifyModel(input);
  state.sessions[sessionKey] = {
    modelClass,
    updatedAtMs: Date.now()
  };
  return modelClass;
}

async function recordPromptStart(state: PluginState, sessionKey: string, input: HookInput): Promise<PromptStartDebug> {
  const match = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL);
  const transcriptStartOffset = await getTranscriptSize(input);
  const sessionBefore = state.sessions[sessionKey];
  const resolution = await resolvePromptStartModelClass(input, sessionBefore, transcriptStartOffset);
  const modelClass = resolution.modelClass;
  if (modelClass !== "unknown") {
    state.sessions[sessionKey] = {
      modelClass,
      updatedAtMs: Date.now()
    };
  }
  state.pending[sessionKey] = {
    startedAtMs: Date.now(),
    targetMatched: match.matched === true,
    ...(transcriptStartOffset !== null ? { transcriptStartOffset } : {}),
    ...(modelClass !== "unknown" ? { modelClass } : {})
  };
  return {
    targetMatched: match.matched === true,
    transcriptStartOffset,
    sessionBefore: summarizeTurnState(sessionBefore),
    promptModelClass: modelClass,
    promptSource: resolution.source,
    directInputModelClass: resolution.directInputModelClass,
    promptTranscript: resolution.transcript,
    pendingAfter: summarizeTurnState(state.pending[sessionKey]),
    sessionAfter: summarizeTurnState(state.sessions[sessionKey])
  };
}

async function reportCompletion({
  eventName,
  input,
  state,
  config,
  sessionKey
}: {
  eventName: string;
  input: HookInput;
  state: PluginState;
  config: RemoteConfig;
  sessionKey: string;
}): Promise<CompletionDebug> {
  const pending = state.pending[sessionKey];
  delete state.pending[sessionKey];
  const debug: CompletionDebug = {
    pending: summarizeTurnState(pending),
    skipped: null
  };

  if (!pending?.targetMatched) return { ...debug, skipped: "pending_not_target_matched" };
  if (config.reportingEnabled === false) return { ...debug, skipped: "reporting_disabled" };
  const currentMatch = matchTargetBaseUrl(process.env.ANTHROPIC_BASE_URL, config.targetBaseUrlHosts);
  if (!currentMatch.matched) return { ...debug, skipped: "current_target_not_matched" };
  const targetHost = normalizeTargetHost(currentMatch.host);
  if (!targetHost) return { ...debug, skipped: "target_host_invalid" };
  if (hasReachedDailyReportLimit(state)) return { ...debug, skipped: "local_daily_limit" };

  const ok = eventName === "Stop";
  const sampleRate = pickSampleRate(ok, config);
  if (!shouldSample(sampleRate)) return { ...debug, skipped: "sampled_out" };

  const anonymousId = await getDailyAnonymousId(state);
  const turnStartedAtMs = getTurnStartedAtMs([pending]);
  const transcript = await inspectTranscript(input, turnStartedAtMs, pending.transcriptStartOffset);
  const modelResolution = resolveModelClass(input, transcript, pending);
  const modelClass = modelResolution.modelClass;
  debug.transcript = transcript;
  debug.modelResolution = modelResolution;
  if (modelClass !== "unknown") {
    state.sessions[sessionKey] = {
      modelClass,
      updatedAtMs: Date.now()
    };
  }
  const assistantStartDelayMs = turnStartedAtMs !== null && transcript.firstAssistantAtMs !== null
    ? transcript.firstAssistantAtMs - turnStartedAtMs
    : null;
  const payload: ReportPayload = {
    ok,
    errorType: ok ? "none" : classifyError(input),
    errorStatusCode: ok ? null : extractErrorStatusCode(input),
    errorHint: ok ? null : createErrorHint(input),
    modelClass,
    assistantStartBucket: bucketAssistantStart(assistantStartDelayMs),
    timeBucket: createTimeBucket(),
    pluginVersion: PLUGIN_VERSION,
    anonymousId,
    sampleRate,
    targetMatched: true,
    targetHost
  };

  const validation = validateReportPayload(payload);
  debug.payload = summarizePayload(payload, validation.ok);
  if (!validation.ok) return { ...debug, skipped: "payload_invalid" };

  const posted = await postReport(config.apiBaseUrl, payload);
  debug.posted = posted;
  if (posted) {
    state.lastPayload = payload;
    state.lastReportAt = new Date().toISOString();
    incrementContribution(state);
  }
  return debug;
}

function createPluginUpdateReminderMessage(state: PluginState, config: RemoteConfig): string | null {
  if (!shouldRemindPluginUpdate(state, config.latestPluginVersion)) return null;
  recordPluginUpdateReminder(state, config.latestPluginVersion);
  return `Any Router Status Monitor 插件有新版 ${config.latestPluginVersion}。运行 /plugin update anyrouter-status-monitor@router-vitals，更新后执行 /reload-plugins。`;
}

function writeHookSystemMessage(systemMessage: string): void {
  console.log(JSON.stringify({ systemMessage }));
}

async function postReport(apiBaseUrl: string, payload: ReportPayload): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/v1/report`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": `anyrouter-status-monitor/${PLUGIN_VERSION}`
      },
      body: JSON.stringify(payload)
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

function resolveModelClass(input: HookInput, transcript: TranscriptInspection, ...fallbacks: Array<TurnState | undefined>): ModelResolution {
  const direct = classifyModel(input, { includeEnv: false });
  const fallbackModelClasses = fallbacks
    .map((fallback) => fallback?.modelClass || "unknown")
    .filter((modelClass): modelClass is ModelClass => modelClass === "haiku" || modelClass === "sonnet" || modelClass === "opus" || modelClass === "unknown");
  if (direct !== "unknown") {
    return {
      modelClass: direct,
      source: "direct_input",
      directInputModelClass: direct,
      transcriptModelClass: transcript.modelClass,
      fallbackModelClasses
    };
  }

  if (transcript.modelClass !== "unknown") {
    return {
      modelClass: transcript.modelClass,
      source: "turn_transcript",
      directInputModelClass: direct,
      transcriptModelClass: transcript.modelClass,
      fallbackModelClasses
    };
  }

  for (const fallback of fallbacks) {
    if (fallback?.modelClass && fallback.modelClass !== "unknown") {
      return {
        modelClass: fallback.modelClass,
        source: "fallback",
        directInputModelClass: direct,
        transcriptModelClass: transcript.modelClass,
        fallbackModelClasses
      };
    }
  }

  return {
    modelClass: "unknown",
    source: "unknown",
    directInputModelClass: direct,
    transcriptModelClass: transcript.modelClass,
    fallbackModelClasses
  };
}

async function resolvePromptStartModelClass(
  input: HookInput,
  session: TurnState | undefined,
  transcriptStartOffset: number | null
): Promise<{
  modelClass: ModelClass;
  source: PromptStartDebug["promptSource"];
  directInputModelClass: ModelClass;
  transcript: PromptTranscriptInspection;
}> {
  const direct = classifyModel(input, { includeEnv: false });
  const emptyTranscript: PromptTranscriptInspection = {
    inspected: false,
    modelClass: "unknown",
    modelSetOutputs: [],
    hasUnparsedModelSetOutput: false
  };
  if (direct !== "unknown") {
    return {
      modelClass: direct,
      source: "direct_input",
      directInputModelClass: direct,
      transcript: emptyTranscript
    };
  }

  const transcript = await inspectPromptStartTranscript(input, transcriptStartOffset);
  if (!transcript.inspected) {
    return {
      modelClass: "unknown",
      source: "unknown",
      directInputModelClass: direct,
      transcript
    };
  }

  if (transcript.modelClass !== "unknown") {
    return {
      modelClass: transcript.modelClass,
      source: "prompt_transcript",
      directInputModelClass: direct,
      transcript
    };
  }

  if (transcript.hasUnparsedModelSetOutput) {
    return {
      modelClass: "unknown",
      source: "unparsed_model_set_output",
      directInputModelClass: direct,
      transcript
    };
  }

  const sessionModelClass = session?.modelClass && session.modelClass !== "unknown" ? session.modelClass : "unknown";
  if (sessionModelClass !== "unknown") {
    return {
      modelClass: sessionModelClass,
      source: "session",
      directInputModelClass: direct,
      transcript
    };
  }

  return {
    modelClass: "unknown",
    source: "unknown",
    directInputModelClass: direct,
    transcript
  };
}

async function inspectPromptStartTranscript(input: HookInput, transcriptStartOffset: number | null): Promise<PromptTranscriptInspection> {
  const transcriptPath = getTranscriptPath(input);
  const result: PromptTranscriptInspection = {
    inspected: false,
    modelClass: "unknown",
    modelSetOutputs: [],
    hasUnparsedModelSetOutput: false
  };
  if (!transcriptPath || transcriptStartOffset === null) return result;

  result.inspected = true;
  if (transcriptStartOffset <= 0) return result;

  try {
    const start = Math.max(0, transcriptStartOffset - TRANSCRIPT_MODEL_LOOKBACK_BYTES);
    const stream = createReadStream(transcriptPath, {
      encoding: "utf8",
      start,
      end: transcriptStartOffset - 1
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let skipFirstLine = start > 0;

    for await (const line of lines) {
      if (skipFirstLine) {
        skipFirstLine = false;
        continue;
      }

      const raw = line.trim();
      if (!raw) continue;

      try {
        const record = JSON.parse(raw);
        const modelSetOutput = inspectModelSetOutput(record);
        if (modelSetOutput) {
          result.modelSetOutputs.push(modelSetOutput);
          if (modelSetOutput.modelClass === "unknown") {
            result.modelClass = "unknown";
            result.hasUnparsedModelSetOutput = true;
            continue;
          }
        }

        const modelClass = (modelSetOutput?.modelClass !== "unknown" ? modelSetOutput?.modelClass : null)
          || classifyTranscriptRecord(record);
        if (modelClass !== "unknown") {
          result.modelClass = modelClass;
          result.hasUnparsedModelSetOutput = false;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return {
      inspected: false,
      modelClass: "unknown",
      modelSetOutputs: [],
      hasUnparsedModelSetOutput: false
    };
  }

  return result;
}

async function inspectTranscript(
  input: HookInput,
  turnStartedAtMs: number | null,
  transcriptStartOffset: number | undefined
): Promise<TranscriptInspection> {
  const transcriptPath = getTranscriptPath(input);
  const result: TranscriptInspection = {
    firstAssistantAtMs: null,
    modelClass: "unknown",
    modelObservations: []
  };
  if (!transcriptPath) return result;

  try {
    const start = Number.isFinite(transcriptStartOffset) && Number(transcriptStartOffset) > 0
      ? Number(transcriptStartOffset)
      : 0;
    const stream = createReadStream(transcriptPath, { encoding: "utf8", start });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;

      try {
        const record = JSON.parse(raw);
        const timestampMs = getRecordTimestampMs(record);
        if (turnStartedAtMs !== null && timestampMs !== null && timestampMs < turnStartedAtMs) continue;

        if (result.firstAssistantAtMs === null && isAssistantRecord(record) && timestampMs !== null) {
          result.firstAssistantAtMs = timestampMs;
        }

        const modelClass = classifyTranscriptRecord(record);
        const candidates = collectModelCandidates(record, "record");
        if (candidates.length > 0 && result.modelObservations.length < 20) {
          result.modelObservations.push({
            timestampMs,
            recordType: getRecordType(record),
            modelClass,
            candidates
          });
        }
        if (modelClass !== "unknown") result.modelClass = modelClass;
      } catch {
        continue;
      }
    }

    return result;
  } catch {
    return result;
  }
}

function getTranscriptPath(input: HookInput): string | null {
  const value = input.transcript_path ?? input.transcriptPath;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

function getTurnStartedAtMs(turns: Array<TurnState | undefined>): number | null {
  for (const turn of turns) {
    if (typeof turn?.startedAtMs === "number" && Number.isFinite(turn.startedAtMs)) return turn.startedAtMs;
  }
  return null;
}

async function getTranscriptSize(input: HookInput): Promise<number | null> {
  const transcriptPath = getTranscriptPath(input);
  if (!transcriptPath) return null;
  try {
    const info = await stat(transcriptPath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function getRecordTimestampMs(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.message) ? value.message : null;

  for (const candidate of [
    value.timestamp,
    value.created_at,
    value.createdAt,
    nested?.timestamp,
    nested?.created_at,
    nested?.createdAt
  ]) {
    const timestampMs = normalizeTimestampMs(candidate);
    if (timestampMs !== null) return timestampMs;
  }

  return null;
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyTranscriptRecord(value: unknown): ModelClass {
  if (!isRecord(value)) return "unknown";

  for (const candidate of [value, value.message, value.request, value.response]) {
    if (!isRecord(candidate)) continue;
    const modelClass = classifyModel(candidate, { includeEnv: false });
    if (modelClass !== "unknown") return modelClass;
  }

  return "unknown";
}

function classifyModelSetOutput(value: unknown): ModelClass | null {
  const output = inspectModelSetOutput(value);
  return output && output.modelClass !== "unknown" ? output.modelClass : null;
}

function inspectModelSetOutput(value: unknown): ModelSetOutputObservation | null {
  if (!isRecord(value)) return null;
  const message = isRecord(value.message) ? value.message : null;
  const text = getStringContent(value.content) ?? getStringContent(message?.content);
  if (!text) return null;

  const lower = text.toLowerCase();
  const isLocalCommand = value.subtype === "local_command"
    || message?.subtype === "local_command"
    || lower.includes("<local-command-stdout>");
  if (!isLocalCommand) return null;

  const normalized = stripAnsiControlSequences(text);
  const match = normalized.match(/(?:^|[>\r\n])\s*set\s+model\s+to\s+(opus|sonnet|haiku)\b/i);
  if (!match) {
    if (!/(?:^|[>\r\n])\s*set\s+model\s+to\b/i.test(normalized)) return null;
    return {
      timestampMs: getRecordTimestampMs(value),
      modelClass: "unknown",
      hasAnsi: hasAnsiControlSequence(text),
      textPreview: previewText(text)
    };
  }

  const model = match[1]!.toLowerCase();
  const modelClass = model === "opus" || model === "sonnet" || model === "haiku" ? model : "unknown";
  return {
    timestampMs: getRecordTimestampMs(value),
    modelClass,
    hasAnsi: hasAnsiControlSequence(text),
    textPreview: previewText(text)
  };
}

function getStringContent(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function writeHookDebug(sessionKey: string, stage: string, data: Record<string, unknown>): Promise<void> {
  await appendHookDebugRecord({
    at: new Date().toISOString(),
    eventName,
    sessionKey,
    stage,
    data
  });
}

function summarizeHookInput(input: HookInput): Record<string, unknown> {
  return {
    keys: Object.keys(input).sort(),
    directInputModelClass: classifyModel(input, { includeEnv: false }),
    envModelClass: classifyModel({}, { includeEnv: true }),
    modelCandidates: collectModelCandidates(input, "input"),
    transcriptPath: getTranscriptPath(input),
    errorType: classifyError(input),
    errorStatusCode: extractErrorStatusCode(input),
    errorHint: createErrorHint(input)
  };
}

function summarizeTurnState(turn: TurnState | undefined): Record<string, unknown> | null {
  if (!turn) return null;
  return {
    ...(typeof turn.startedAtMs === "number" ? { startedAtMs: turn.startedAtMs } : {}),
    ...(typeof turn.updatedAtMs === "number" ? { updatedAtMs: turn.updatedAtMs } : {}),
    ...(typeof turn.transcriptStartOffset === "number" ? { transcriptStartOffset: turn.transcriptStartOffset } : {}),
    ...(typeof turn.targetMatched === "boolean" ? { targetMatched: turn.targetMatched } : {}),
    ...(turn.modelClass ? { modelClass: turn.modelClass } : {})
  };
}

function summarizePayload(payload: ReportPayload, validationOk: boolean): Record<string, unknown> {
  return {
    validationOk,
    ok: payload.ok,
    errorType: payload.errorType,
    errorStatusCode: payload.errorStatusCode,
    errorHint: payload.errorHint,
    modelClass: payload.modelClass,
    assistantStartBucket: payload.assistantStartBucket,
    targetMatched: payload.targetMatched,
    targetHost: payload.targetHost,
    sampleRate: payload.sampleRate,
    pluginVersion: payload.pluginVersion
  };
}

function collectModelCandidates(value: unknown, prefix: string): ModelCandidateObservation[] {
  if (!isRecord(value)) return [];
  const result: ModelCandidateObservation[] = [];
  const seen = new Set<string>();

  collectModelCandidatesFromRecord(value, prefix, result, seen);
  for (const key of ["message", "request", "response", "error"]) {
    const child = value[key];
    if (isRecord(child)) collectModelCandidatesFromRecord(child, `${prefix}.${key}`, result, seen);
  }

  return result;
}

function collectModelCandidatesFromRecord(
  value: Record<string, unknown>,
  prefix: string,
  result: ModelCandidateObservation[],
  seen: Set<string>
): void {
  addModelCandidate(result, seen, `${prefix}.model`, value.model);
  addModelCandidate(result, seen, `${prefix}.model_id`, value.model_id);
  addModelCandidate(result, seen, `${prefix}.model_name`, value.model_name);

  const nestedModel = isRecord(value.model) ? value.model : null;
  if (nestedModel) {
    addModelCandidate(result, seen, `${prefix}.model.id`, nestedModel.id);
    addModelCandidate(result, seen, `${prefix}.model.name`, nestedModel.name);
    addModelCandidate(result, seen, `${prefix}.model.display_name`, nestedModel.display_name);
    addModelCandidate(result, seen, `${prefix}.model.displayName`, nestedModel.displayName);
  }
}

function addModelCandidate(
  result: ModelCandidateObservation[],
  seen: Set<string>,
  path: string,
  value: unknown
): void {
  if (typeof value !== "string" || value.trim() === "") return;
  if (seen.has(path)) return;
  seen.add(path);
  result.push({
    path,
    value: previewText(value),
    modelClass: classifyModel({ model: value }, { includeEnv: false })
  });
}

function getRecordType(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const parts = [value.type, value.subtype].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length > 0 ? parts.join(":") : null;
}

function hasAnsiControlSequence(value: string): boolean {
  return /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/.test(value);
}

function stripAnsiControlSequences(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function previewText(value: string): string {
  return value
    .replace(/\x1B/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .slice(0, 240);
}

function isAssistantRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "assistant" || value.role === "assistant") return true;
  const message = isRecord(value.message) ? value.message : null;
  return message?.type === "assistant" || message?.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
