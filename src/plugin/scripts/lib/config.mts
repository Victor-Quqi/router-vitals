import { DEFAULT_CONFIG_URL, DEFAULT_REMOTE_CONFIG, sanitizeRemoteConfig, type RemoteConfig } from "./policy.mjs";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ConfigCache {
  value: RemoteConfig;
  expiresAt: number;
}

interface ConfigGlobal {
  __ROUTER_VITALS_CONFIG_CACHE__?: ConfigCache;
}

export async function loadRemoteConfig(fetchImpl: typeof fetch = fetch): Promise<RemoteConfig> {
  const envDisabled = process.env.ROUTER_VITALS_DISABLED === "1";
  if (envDisabled) return { ...DEFAULT_REMOTE_CONFIG, reportingEnabled: false };

  const cached = readMemoryCache();
  if (cached) return cached;

  const url = process.env.ROUTER_VITALS_CONFIG_URL || DEFAULT_CONFIG_URL;
  try {
    const response = await fetchWithTimeout(fetchImpl, url, 900);
    if (!response.ok) throw new Error(`config http ${response.status}`);
    const json = await response.json();
    const remoteConfig = isRecord(json) ? json : {};
    const config = sanitizeRemoteConfig({
      ...remoteConfig,
      apiBaseUrl: process.env.ROUTER_VITALS_API_BASE_URL || remoteConfig.apiBaseUrl
    });
    writeMemoryCache(config);
    return config;
  } catch {
    const config = sanitizeRemoteConfig({
      ...DEFAULT_REMOTE_CONFIG,
      apiBaseUrl: process.env.ROUTER_VITALS_API_BASE_URL || DEFAULT_REMOTE_CONFIG.apiBaseUrl
    });
    writeMemoryCache(config);
    return config;
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(timeout);
  }
}

function readMemoryCache(): RemoteConfig | null {
  const cached = (globalThis as typeof globalThis & ConfigGlobal).__ROUTER_VITALS_CONFIG_CACHE__;
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.value;
}

function writeMemoryCache(value: RemoteConfig): void {
  (globalThis as typeof globalThis & ConfigGlobal).__ROUTER_VITALS_CONFIG_CACHE__ = {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
