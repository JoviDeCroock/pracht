/**
 * Cloudflare Workers Cache (Workers Caching) support.
 *
 * Workers Caching sits in front of the Worker: Cloudflare stores responses
 * whose caching headers mark them cacheable and serves repeat requests
 * without invoking the Worker at all. Pracht maps time-revalidated ISG routes
 * onto it and exposes the Workers-only purge API for explicit invalidation.
 *
 * Everything behind this facade stays safe to bundle into the worker — no
 * `vite` or Node imports.
 */

// Re-exported from its original home so `@pracht/adapter-cloudflare/cache`
// keeps working; the implementation moved to @pracht/core so Node and Vercel
// apply the identical default (see runtime-headers.ts).
export { preventHeuristicCaching } from "@pracht/core/server";

export {
  applyWorkersCacheHeaders,
  findCacheableIsgRoute,
  ISG_CACHE_TAG,
  resolveWorkersCacheOptions,
  routeCacheTag,
} from "./cache-policy.ts";
export { purgeCache } from "./cache-purge.ts";
export type {
  CloudflareWorkersCacheOption,
  CloudflareWorkersCacheOptions,
  PurgeCacheOptions,
} from "./cache-types.ts";
