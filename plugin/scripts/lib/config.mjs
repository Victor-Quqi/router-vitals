import { DEFAULT_CONFIG_URL, DEFAULT_REMOTE_CONFIG, sanitizeRemoteConfig } from "./policy.mjs";
const CACHE_TTL_MS = 5 * 60 * 1000;
export async function loadRemoteConfig(fetchImpl = fetch) {
    const envDisabled = process.env.ROUTER_VITALS_DISABLED === "1";
    if (envDisabled)
        return { ...DEFAULT_REMOTE_CONFIG, reportingEnabled: false };
    const cached = readMemoryCache();
    if (cached)
        return cached;
    const url = process.env.ROUTER_VITALS_CONFIG_URL || DEFAULT_CONFIG_URL;
    try {
        const response = await fetchWithTimeout(fetchImpl, url, 900);
        if (!response.ok)
            throw new Error(`config http ${response.status}`);
        const json = await response.json();
        const remoteConfig = isRecord(json) ? json : {};
        const config = sanitizeRemoteConfig({
            ...remoteConfig,
            apiBaseUrl: process.env.ROUTER_VITALS_API_BASE_URL || remoteConfig.apiBaseUrl
        });
        writeMemoryCache(config);
        return config;
    }
    catch {
        const config = sanitizeRemoteConfig({
            ...DEFAULT_REMOTE_CONFIG,
            apiBaseUrl: process.env.ROUTER_VITALS_API_BASE_URL || DEFAULT_REMOTE_CONFIG.apiBaseUrl
        });
        writeMemoryCache(config);
        return config;
    }
}
async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    }
    finally {
        clearTimeout(timeout);
    }
}
function readMemoryCache() {
    const cached = globalThis.__ROUTER_VITALS_CONFIG_CACHE__;
    if (!cached || cached.expiresAt <= Date.now())
        return null;
    return cached.value;
}
function writeMemoryCache(value) {
    globalThis.__ROUTER_VITALS_CONFIG_CACHE__ = {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
