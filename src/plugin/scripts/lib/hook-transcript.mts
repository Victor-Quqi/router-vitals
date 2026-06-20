import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { classifyModel, type ModelClass } from "./policy.mjs";

const TRANSCRIPT_MODEL_LOOKBACK_BYTES = 256 * 1024;

export type HookInput = Record<string, any>;

export interface TranscriptInspection {
  firstAssistantAtMs: number | null;
  modelClass: ModelClass;
  modelObservations: TranscriptModelObservation[];
}

export interface PromptTranscriptInspection {
  inspected: boolean;
  modelClass: ModelClass;
  modelSetOutputs: ModelSetOutputObservation[];
  hasUnparsedModelSetOutput: boolean;
}

export interface ModelCandidateObservation {
  path: string;
  value: string;
  modelClass: ModelClass;
}

export interface ModelSetOutputObservation {
  timestampMs: number | null;
  modelClass: ModelClass;
  hasAnsi: boolean;
  textPreview: string;
}

export interface TranscriptModelObservation {
  timestampMs: number | null;
  recordType: string | null;
  modelClass: ModelClass;
  candidates: ModelCandidateObservation[];
}

export async function getTranscriptSize(input: HookInput): Promise<number | null> {
  const transcriptPath = getTranscriptPath(input);
  if (!transcriptPath) return null;
  try {
    const info = await stat(transcriptPath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export function getTranscriptPath(input: HookInput): string | null {
  const value = input.transcript_path ?? input.transcriptPath;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

export async function inspectPromptStartTranscript(
  input: HookInput,
  transcriptStartOffset: number | null
): Promise<PromptTranscriptInspection> {
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

export async function inspectTranscript(
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

export function collectModelCandidates(value: unknown, prefix: string): ModelCandidateObservation[] {
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

function classifyTranscriptRecord(value: unknown): ModelClass {
  if (!isRecord(value)) return "unknown";

  for (const candidate of [value, value.message, value.request, value.response]) {
    if (!isRecord(candidate)) continue;
    const modelClass = classifyModel(candidate, { includeEnv: false });
    if (modelClass !== "unknown") return modelClass;
  }

  return "unknown";
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

function getStringContent(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
