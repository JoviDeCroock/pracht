import type { PurgeCacheOptions } from "./cache-types.ts";

interface CloudflareWorkersCacheModule {
  cache?: { purge(options: PurgeCacheOptions): Promise<unknown> };
}

const CLOUDFLARE_WORKERS_MODULE = "cloudflare:workers";

/**
 * Invalidate Workers Caching entries from anywhere in the app — loaders,
 * API routes, middleware, queue handlers. This is how webhook-based ISG
 * revalidation works on Cloudflare:
 *
 * ```ts
 * // src/api/revalidate.ts
 * import { purgeCache, routeCacheTag } from "@pracht/adapter-cloudflare/cache";
 *
 * export async function POST() {
 *   await purgeCache({ tags: [routeCacheTag("pricing")] });
 *   return Response.json({ revalidated: true });
 * }
 * ```
 *
 * Wraps `cache.purge()` from `cloudflare:workers`, which only exists inside
 * the Workers runtime. Outside it (Node, tests, prerendering) this throws a
 * descriptive error instead of a resolution failure.
 */
export async function purgeCache(options: PurgeCacheOptions): Promise<unknown> {
  if (!options.purgeEverything && !options.tags?.length && !options.pathPrefixes?.length) {
    throw new Error("purgeCache() expects `tags`, `pathPrefixes`, or `purgeEverything: true`.");
  }
  if (options.purgeEverything && (options.tags?.length || options.pathPrefixes?.length)) {
    throw new Error(
      "purgeCache() with `purgeEverything: true` cannot be combined with `tags` or `pathPrefixes`.",
    );
  }

  let workers: CloudflareWorkersCacheModule;
  try {
    // Computed specifier: keeps TypeScript from trying to resolve the
    // workers-only module and keeps bundlers from inlining it; workerd
    // resolves its built-in modules at runtime.
    workers = (await import(
      /* @vite-ignore */ CLOUDFLARE_WORKERS_MODULE
    )) as CloudflareWorkersCacheModule;
  } catch {
    throw new Error(
      "purgeCache() is only available on the Cloudflare Workers runtime — `cloudflare:workers` could not be imported.",
    );
  }

  if (typeof workers.cache?.purge !== "function") {
    throw new Error(
      "purgeCache() requires the Workers Caching runtime API (`cache.purge` from `cloudflare:workers`). " +
        'Enable it with `"cache": { "enabled": true }` in wrangler.jsonc and make sure wrangler is up to date.',
    );
  }

  return workers.cache.purge(options);
}
