import type { RouteStateResult } from "./runtime-client-fetch.ts";

const CACHE_TTL_MS = 30_000;
const MAX_PREFETCH_CACHE_ENTRIES = 100;
const EMPTY_ROUTE_STATE: RouteStateResult = { type: "data", data: undefined };

interface CacheEntry {
  promise: Promise<RouteStateResult>;
  timestamp: number;
}

const prefetchCache = new Map<string, CacheEntry>();

export const EMPTY_ROUTE_STATE_PROMISE: Promise<RouteStateResult> =
  Promise.resolve(EMPTY_ROUTE_STATE);

export function clearPrefetchCache(): void {
  prefetchCache.clear();
}

export function getCachedRouteState(url: string): Promise<RouteStateResult> | null {
  const entry = prefetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    prefetchCache.delete(url);
    return null;
  }

  // Refresh insertion order so the map acts as a small LRU cache.
  prefetchCache.delete(url);
  prefetchCache.set(url, entry);
  return entry.promise;
}

export function cacheRouteState(url: string, promise: Promise<RouteStateResult>): void {
  sweepPrefetchCache();
  prefetchCache.set(url, { promise, timestamp: Date.now() });
  trimMapToSize(prefetchCache, MAX_PREFETCH_CACHE_ENTRIES);
}

function sweepPrefetchCache(now = Date.now()): void {
  for (const [url, entry] of prefetchCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      prefetchCache.delete(url);
    }
  }
}

export function trimMapToSize<TKey, TValue>(map: Map<TKey, TValue>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}
