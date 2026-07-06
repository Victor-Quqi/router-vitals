import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { classifyModel, type ModelClass } from "./policy.mjs";

const TRANSCRIPT_MODEL_LOOKBACK_BYTES = 256 * 1024;
const PROJECT_MODEL_SWITCH_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const PROJECT_MODEL_SWITCH_MAX_FILES = 80;
const PROJECT_MODEL_SWITCH_MAX_FILE_BYTES = 16 * 1024 * 1024;

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

export interface ProjectModelSwitchInspection {
  inspected: boolean;
  modelClass: ModelClass;
  timestampMs: number | null;
  transcriptPath: string | null;
  textPreview: string | null;
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

export async function inspectRecentProjectModelSwitch(
  input: HookInput,
  beforeMs = Date.now()
): Promise<ProjectModelSwitchInspection> {
  const result: ProjectModelSwitchInspection = {
    inspected: false,
    modelClass: "unknown",
    timestampMs: null,
    transcriptPath: null,
    textPreview: null
  };
  if (!isTaskNotificationInput(input)) return result;

  const transcriptPath = getTranscriptPath(input);
  if (!transcriptPath) return result;

  result.inspected = true;
  try {
    const candidates = await listRecentProjectTranscripts(dirname(transcriptPath), beforeMs);
    for (const path of candidates) {
      const modelSwitch = await inspectModelSwitchesInFile(path, beforeMs);
      if (!modelSwitch) continue;
      if (result.timestampMs === null || modelSwitch.timestampMs > result.timestampMs) {
        result.modelClass = modelSwitch.modelClass;
        result.timestampMs = modelSwitch.timestampMs;
        result.transcriptPath = path;
        result.textPreview = modelSwitch.textPreview;
      }
    }
  } catch {
    return {
      inspected: false,
      modelClass: "unknown",
      timestampMs: null,
      transcriptPath: null,
      textPreview: null
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

async function listRecentProjectTranscripts(projectDir: string, beforeMs: number): Promise<string[]> {
  const cutoffMs = beforeMs - PROJECT_MODEL_SWITCH_LOOKBACK_MS;
  const entries = await readdir(projectDir, { withFileTypes: true });
  const files: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(projectDir, entry.name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (info.size > PROJECT_MODEL_SWITCH_MAX_FILE_BYTES) continue;
      if (info.mtimeMs < cutoffMs) continue;
      files.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, PROJECT_MODEL_SWITCH_MAX_FILES)
    .map((file) => file.path);
}

async function inspectModelSwitchesInFile(
  path: string,
  beforeMs: number
): Promise<{ modelClass: ModelClass; timestampMs: number; textPreview: string } | null> {
  let latest: { modelClass: ModelClass; timestampMs: number; textPreview: string } | null = null;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.includes("Set model to")) continue;
      const raw = line.trim();
      if (!raw) continue;

      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }

      const modelSetOutput = inspectModelSetOutput(record);
      if (!modelSetOutput || modelSetOutput.modelClass === "unknown") continue;
      if (!modelSetOutput.textPreview.toLowerCase().includes("saved as your default for new sessions")) continue;
      const timestampMs = modelSetOutput.timestampMs;
      if (timestampMs === null || timestampMs > beforeMs + 1000) continue;
      if (!latest || timestampMs > latest.timestampMs) {
        latest = {
          modelClass: modelSetOutput.modelClass,
          timestampMs,
          textPreview: modelSetOutput.textPreview
        };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return latest;
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
  const match = normalized.match(/(?:^|[>\r\n])\s*set\s+model\s+to\s+(fable|opus|sonnet|haiku)\b/i);
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
  const modelClass = model === "fable" || model === "opus" || model === "sonnet" || model === "haiku" ? model : "unknown";
  return {
    timestampMs: getRecordTimestampMs(value),
    modelClass,
    hasAnsi: hasAnsiControlSequence(text),
    textPreview: previewText(text)
  };
}

function isTaskNotificationInput(input: HookInput): boolean {
  const prompt = input.prompt;
  return typeof prompt === "string"
    && prompt.includes("<task-notification>")
    && prompt.includes("<tool-use-id>");
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
