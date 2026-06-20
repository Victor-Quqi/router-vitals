import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getPluginStateDir } from "./state.mjs";
const DEBUG_LOG_FILE_NAME = "debug-hook.jsonl";
export function isHookDebugEnabled() {
    return process.env.ANYROUTER_STATUS_DEBUG_HOOK === "1";
}
export function getHookDebugLogPath() {
    return join(getPluginStateDir(), DEBUG_LOG_FILE_NAME);
}
export async function appendHookDebugRecord(record) {
    if (!isHookDebugEnabled())
        return;
    try {
        const path = getHookDebugLogPath();
        await mkdir(getPluginStateDir(), { recursive: true });
        await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    }
    catch {
        // Debug logging must never affect hook behavior.
    }
}
