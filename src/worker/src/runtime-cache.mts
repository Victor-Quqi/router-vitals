export interface ResponseBodyCache {
  get(key: string): Promise<string | null>;
  put(key: string, body: string, ttlMs: number): Promise<void>;
}

interface PlatformCaches {
  default?: Cache;
}

interface CacheGlobal {
  caches?: PlatformCaches;
}

export function createPlatformResponseBodyCache(): ResponseBodyCache | null {
  const cache = (globalThis as typeof globalThis & CacheGlobal).caches?.default;
  if (!cache) return null;

  return {
    async get(key: string): Promise<string | null> {
      const response = await cache.match(createCacheRequest(key));
      return response ? response.text() : null;
    },
    async put(key: string, body: string, ttlMs: number): Promise<void> {
      await cache.put(createCacheRequest(key), new Response(body, {
        headers: {
          "cache-control": `public, max-age=${Math.max(0, Math.floor(ttlMs / 1000))}`
        }
      }));
    }
  };
}

export function createMemoryResponseBodyCache(options: { maxEntries?: number; now?: () => number } = {}): ResponseBodyCache {
  const maxEntries = options.maxEntries ?? 128;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { body: string; expiresAt: number }>();

  function prune(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(key);
    }

    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (typeof oldest !== "string") break;
      entries.delete(oldest);
    }
  }

  return {
    async get(key: string): Promise<string | null> {
      const nowMs = now();
      prune(nowMs);
      const entry = entries.get(key);
      return entry && entry.expiresAt > nowMs ? entry.body : null;
    },
    async put(key: string, body: string, ttlMs: number): Promise<void> {
      const nowMs = now();
      entries.set(key, { body, expiresAt: nowMs + ttlMs });
      prune(nowMs);
    }
  };
}

function createCacheRequest(key: string): Request {
  return new Request(`https://router-vitals.local/cache/${encodeURIComponent(key)}`);
}
