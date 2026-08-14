export interface CloudflareWorkersCacheOptions {
  /**
   * Seconds a stale ISG page may keep being served while the Worker
   * re-renders it in the background. Defaults to one year, which gives
   * classic ISG semantics: after the revalidate window a visitor always
   * gets the cached page instantly and the refresh happens off the
   * critical path.
   */
  staleWhileRevalidate?: number;
}

export type CloudflareWorkersCacheOption = boolean | CloudflareWorkersCacheOptions;

export interface PurgeCacheOptions {
  /** Purge cached responses tagged with any of these `Cache-Tag` values. */
  tags?: string[];
  /** Purge cached responses whose request path starts with any of these prefixes. */
  pathPrefixes?: string[];
  /** Purge every cached response for this Worker entrypoint. Exclusive with the other fields. */
  purgeEverything?: boolean;
}
