import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getCodexHome } from "./codex-target.mjs";

const LOG_DATABASE_FILE_NAME = "logs_2.sqlite";
const TURN_ERROR_TARGET = "codex_core::session::turn";
const TURN_ERROR_MARKER = "Turn error:";
const QUERY_MAX_WINDOW_MS = 24 * 60 * 60_000;
const QUERY_LIMIT = 5;
const MESSAGE_LIMIT = 4_096;
const DATABASE_TIMEOUT_MS = 100;

interface CodexLogErrorRow {
  message?: unknown;
}

export interface CodexLogErrorQuery {
  sessionId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

export function readCodexTurnLogErrors(
  query: CodexLogErrorQuery,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const bounds = normalizeQueryBounds(query);
  if (!bounds || !query.sessionId) return [];

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(join(getCodexHome(env), LOG_DATABASE_FILE_NAME), {
      readOnly: true,
      timeout: DATABASE_TIMEOUT_MS
    });
    const rows = database.prepare(`
      SELECT substr(
        feedback_log_body,
        instr(feedback_log_body, ?) + length(?),
        ?
      ) AS message
      FROM logs
      WHERE thread_id = ?
        AND ts BETWEEN ? AND ?
        AND target = ?
        AND instr(feedback_log_body, ?) > 0
      ORDER BY ts DESC, ts_nanos DESC, id DESC
      LIMIT ?
    `).all(
      TURN_ERROR_MARKER,
      TURN_ERROR_MARKER,
      MESSAGE_LIMIT,
      query.sessionId,
      bounds.startedAtSeconds,
      bounds.endedAtSeconds,
      TURN_ERROR_TARGET,
      TURN_ERROR_MARKER,
      QUERY_LIMIT
    ) as CodexLogErrorRow[];

    const seen = new Set<string>();
    const messages: string[] = [];
    for (const row of rows) {
      if (typeof row.message !== "string") continue;
      const message = row.message.trim();
      if (!message || seen.has(message)) continue;
      seen.add(message);
      messages.push(message);
    }
    return messages;
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {
      // A failed diagnostic lookup must not affect turn settlement.
    }
  }
}

function normalizeQueryBounds(query: CodexLogErrorQuery): {
  startedAtSeconds: number;
  endedAtSeconds: number;
} | null {
  if (!isFiniteTimestamp(query.startedAtMs) || !isFiniteTimestamp(query.endedAtMs)) return null;
  if (query.endedAtMs < query.startedAtMs) return null;

  const endedAtMs = Math.min(query.endedAtMs, query.startedAtMs + QUERY_MAX_WINDOW_MS);
  return {
    startedAtSeconds: Math.floor(query.startedAtMs / 1000),
    endedAtSeconds: Math.floor(endedAtMs / 1000)
  };
}

function isFiniteTimestamp(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
