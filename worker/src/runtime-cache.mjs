export function createPlatformResponseBodyCache() {
    const cache = globalThis.caches?.default;
    if (!cache)
        return null;
    return {
        async get(key) {
            const response = await cache.match(createCacheRequest(key));
            return response ? response.text() : null;
        },
        async put(key, body, ttlMs) {
            await cache.put(createCacheRequest(key), new Response(body, {
                headers: {
                    "cache-control": `public, max-age=${Math.max(0, Math.floor(ttlMs / 1000))}`
                }
            }));
        }
    };
}
export function createMemoryResponseBodyCache(options = {}) {
    const maxEntries = options.maxEntries ?? 128;
    const now = options.now ?? Date.now;
    const entries = new Map();
    function prune(nowMs) {
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= nowMs)
                entries.delete(key);
        }
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (typeof oldest !== "string")
                break;
            entries.delete(oldest);
        }
    }
    return {
        async get(key) {
            const nowMs = now();
            prune(nowMs);
            const entry = entries.get(key);
            return entry && entry.expiresAt > nowMs ? entry.body : null;
        },
        async put(key, body, ttlMs) {
            const nowMs = now();
            entries.set(key, { body, expiresAt: nowMs + ttlMs });
            prune(nowMs);
        }
    };
}
function createCacheRequest(key) {
    return new Request(`https://router-vitals.local/cache/${encodeURIComponent(key)}`);
}
