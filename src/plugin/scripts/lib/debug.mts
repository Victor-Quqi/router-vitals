import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getPluginStateDir } from "./state.mjs";

const DEBUG_LOG_FILE_NAME = "debug-hook.jsonl";

export interface HookDebugRecord {
  at: string;
  eventName: string;
  sessionKey: string;
  stage: string;
  data: Record<string, unknown>;
}

export function isHookDebugEnabled(): boolean {
  return process.env.ANYROUTER_STATUS_DEBUG_HOOK === "1";
}

export function getHookDebugLogPath(): string {
  return join(getPluginStateDir(), DEBUG_LOG_FILE_NAME);
}

export async function appendHookDebugRecord(record: HookDebugRecord): Promise<void> {
  if (!isHookDebugEnabled()) return;

  try {
    const path = getHookDebugLogPath();
    await mkdir(getPluginStateDir(), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Debug logging must never affect hook behavior.
  }
}
