import { PLUGIN_VERSION, type ReportPayload } from "./policy.mjs";
import { PLUGIN_ID } from "./site-config.mjs";
import type { LastDecision, PluginState } from "./state.mjs";

export type PostReportResult =
  | { ok: true; statusCode: number }
  | { ok: false; reason: "timeout" | "http_error" | "network_error"; statusCode?: number };

export async function postReport(apiBaseUrl: string, payload: ReportPayload): Promise<PostReportResult> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 3000);
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/v1/report`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": `${PLUGIN_ID}/${PLUGIN_VERSION}`
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) return { ok: true, statusCode: response.status };
    return { ok: false, reason: "http_error", statusCode: response.status };
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "network_error" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function recordLastDecision(
  state: PluginState,
  eventName: LastDecision["eventName"],
  decision: Omit<LastDecision, "at" | "eventName">
): void {
  state.lastDecision = {
    at: new Date().toISOString(),
    eventName,
    ...decision
  };
}

export function summarizePostResult(result: PostReportResult): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(result.ok ? { statusCode: result.statusCode } : { reason: result.reason }),
    ...(!result.ok && result.statusCode ? { statusCode: result.statusCode } : {})
  };
}
