import { PLUGIN_VERSION } from "./policy.mjs";
import { PLUGIN_ID } from "./site-config.mjs";
export async function postReport(apiBaseUrl, payload) {
    let timedOut = false;
    let timeout = null;
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
        if (response.ok)
            return { ok: true, statusCode: response.status };
        return { ok: false, reason: "http_error", statusCode: response.status };
    }
    catch {
        return { ok: false, reason: timedOut ? "timeout" : "network_error" };
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
export function recordLastDecision(state, eventName, decision) {
    state.lastDecision = {
        at: new Date().toISOString(),
        eventName,
        ...decision
    };
}
export function summarizePostResult(result) {
    return {
        ok: result.ok,
        ...(result.ok ? { statusCode: result.statusCode } : { reason: result.reason }),
        ...(!result.ok && result.statusCode ? { statusCode: result.statusCode } : {})
    };
}
