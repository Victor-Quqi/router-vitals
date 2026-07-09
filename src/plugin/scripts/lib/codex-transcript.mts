import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

const MODEL_OUTPUT_RESPONSE_ITEM_TYPES = new Set([
  "reasoning",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call"
]);

// Codex persists task_started/turn_context BEFORE running the UserPromptSubmit
// hook, so an offset captured inside that hook lands past the turn's start
// markers. Rewinding a bounded window recovers them; turn-id gating makes the
// extra records harmless.
const TURN_START_REWIND_BYTES = 64 * 1024;
const TAIL_READ_CHUNK_BYTES = 64 * 1024;

export type CodexTurnTerminalState = "completed" | "aborted";

export class CodexTurnTailer {
  private offset: number;
  private partialLine = "";
  private decoder = new StringDecoder("utf8");

  constructor(startOffset: number | undefined) {
    this.offset = Number.isFinite(startOffset) && Number(startOffset) > 0 ? Number(startOffset) : 0;
  }

  get currentOffset(): number {
    return this.offset;
  }

  async poll(transcriptPath: string | null, turnId: string | null): Promise<CodexTurnTerminalState | null> {
    if (!transcriptPath) return null;
    try {
      const file = await open(transcriptPath, "r");
      try {
        const info = await file.stat();
        if (info.size < this.offset) {
          this.offset = 0;
          this.partialLine = "";
          this.decoder = new StringDecoder("utf8");
        }

        while (this.offset < info.size) {
          const buffer = Buffer.allocUnsafe(Math.min(TAIL_READ_CHUNK_BYTES, info.size - this.offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
          if (bytesRead === 0) break;
          this.offset += bytesRead;
          const terminal = this.consume(this.decoder.write(buffer.subarray(0, bytesRead)), turnId);
          if (terminal) return terminal;
        }
        return parseTerminalLine(this.partialLine, turnId);
      } finally {
        await file.close();
      }
    } catch {
      return null;
    }
  }

  private consume(chunk: string, turnId: string | null): CodexTurnTerminalState | null {
    const lines = `${this.partialLine}${chunk}`.split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      const terminal = parseTerminalLine(line, turnId);
      if (terminal) return terminal;
    }
    return null;
  }
}

export interface CodexSessionMeta {
  sessionId: string | null;
  modelProvider: string | null;
  cliVersion: string | null;
  originator: string | null;
}

export interface CodexTurnInspection {
  found: boolean;
  model: string | null;
  aborted: boolean;
  abortReason: string | null;
  completed: boolean;
  hasModelOutput: boolean;
  taskStartedAtMs: number | null;
  firstOutputAtMs: number | null;
  lastActivityAtMs: number | null;
  timeToFirstTokenMs: number | null;
  durationMs: number | null;
  errorMessages: string[];
}

export async function readCodexSessionMeta(transcriptPath: string | null): Promise<CodexSessionMeta | null> {
  if (!transcriptPath) return null;
  try {
    const stream = createReadStream(transcriptPath, { encoding: "utf8", end: 64 * 1024 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;
      lines.close();
      stream.destroy();
      const record = parseRecord(raw);
      if (record?.type !== "session_meta" || !isRecord(record.payload)) return null;
      return {
        sessionId: readString(record.payload.session_id) ?? readString(record.payload.id),
        modelProvider: readString(record.payload.model_provider),
        cliVersion: readString(record.payload.cli_version),
        originator: readString(record.payload.originator)
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Reads the turn's records from the rollout: [startOffset ..] until the turn
// ends (task_complete / turn_aborted with the turn id) or another turn starts.
// The rollout format is not a stable Codex interface; every field access is
// defensive and absence degrades to "no evidence".
export async function inspectCodexTurn(
  transcriptPath: string | null,
  turnId: string | null,
  startOffset: number | undefined
): Promise<CodexTurnInspection> {
  const result: CodexTurnInspection = {
    found: false,
    model: null,
    aborted: false,
    abortReason: null,
    completed: false,
    hasModelOutput: false,
    taskStartedAtMs: null,
    firstOutputAtMs: null,
    lastActivityAtMs: null,
    timeToFirstTokenMs: null,
    durationMs: null,
    errorMessages: []
  };
  if (!transcriptPath) return result;

  try {
    const requestedStart = Number.isFinite(startOffset) && Number(startOffset) > 0 ? Number(startOffset) : 0;
    const start = Math.max(0, requestedStart - TURN_START_REWIND_BYTES);
    const stream = createReadStream(transcriptPath, { encoding: "utf8", start });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let skipFirstLine = start > 0;

    for await (const line of lines) {
      if (skipFirstLine) {
        // A rewound start can land mid-line; drop the partial first line.
        skipFirstLine = false;
        continue;
      }
      const raw = line.trim();
      if (!raw) continue;
      const record = parseRecord(raw);
      if (!record || !isRecord(record.payload)) continue;
      const payload = record.payload;
      const payloadType = readString(payload.type);
      const recordTurnId = readString(payload.turn_id);
      const timestampMs = parseTimestampMs(record.timestamp);

      if (turnId && recordTurnId && recordTurnId !== turnId) {
        // Another turn's marker after ours ends the scan window.
        if (result.found) break;
        continue;
      }
      // Records without a turn id (response items, plain event messages) only
      // count once this turn's own markers have been seen; before that they
      // belong to an earlier turn still inside the scan window.
      const inTurnWindow = !turnId || result.found || recordTurnId === turnId;

      if (record.type === "turn_context") {
        result.found = true;
        markLastActivity(result, timestampMs);
        result.model = readString(payload.model) ?? result.model;
        continue;
      }

      if (record.type === "event_msg") {
        if (payloadType === "task_started") {
          result.found = true;
          markLastActivity(result, timestampMs);
          if (timestampMs !== null) result.taskStartedAtMs = timestampMs;
          continue;
        }
        if (!inTurnWindow) continue;
        markLastActivity(result, timestampMs);
        if (payloadType === "task_complete") {
          result.found = true;
          result.completed = true;
          result.durationMs = readFiniteNumber(payload.duration_ms);
          result.timeToFirstTokenMs = readFiniteNumber(payload.time_to_first_token_ms);
          break;
        }
        if (payloadType === "turn_aborted") {
          result.found = true;
          result.aborted = true;
          result.abortReason = readString(payload.reason);
          break;
        }
        if (payloadType === "error") {
          const message = readString(payload.message);
          if (message && result.errorMessages.length < 5) result.errorMessages.push(message);
          continue;
        }
        if (payloadType === "agent_message") {
          markModelOutput(result, timestampMs);
        }
        continue;
      }

      if (record.type === "response_item" && payloadType && inTurnWindow) {
        markLastActivity(result, timestampMs);
        const isAssistantMessage = payloadType === "message" && readString(payload.role) === "assistant";
        if (isAssistantMessage || MODEL_OUTPUT_RESPONSE_ITEM_TYPES.has(payloadType)) {
          markModelOutput(result, timestampMs);
        }
      }
    }

    return result;
  } catch {
    return result;
  }
}

function markLastActivity(result: CodexTurnInspection, timestampMs: number | null): void {
  if (timestampMs !== null) result.lastActivityAtMs = timestampMs;
}

function markModelOutput(result: CodexTurnInspection, timestampMs: number | null): void {
  result.hasModelOutput = true;
  if (result.firstOutputAtMs === null && timestampMs !== null) result.firstOutputAtMs = timestampMs;
}

function parseRecord(raw: string): { timestamp?: unknown; type?: string; payload?: unknown } | null {
  try {
    const record = JSON.parse(raw);
    return isRecord(record) ? record as { timestamp?: unknown; type?: string; payload?: unknown } : null;
  } catch {
    return null;
  }
}

function parseTerminalLine(raw: string, turnId: string | null): CodexTurnTerminalState | null {
  const record = parseRecord(raw.trim());
  if (record?.type !== "event_msg" || !isRecord(record.payload)) return null;
  const recordTurnId = readString(record.payload.turn_id);
  if (turnId && recordTurnId !== turnId) return null;
  const payloadType = readString(record.payload.type);
  if (payloadType === "task_complete") return "completed";
  if (payloadType === "turn_aborted") return "aborted";
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
