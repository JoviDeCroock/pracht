/** Authenticated Cloudflare ISG webhook regeneration. */

import {
  classifyRevalidationSkip,
  getTimeRevalidateSeconds,
  jsonResponse,
  matchAppRoute,
  type PrachtApp,
  PRACHT_REVALIDATE_TOKEN_ENV,
  readRevalidationRequest,
  RevalidationReport,
} from "@pracht/core/server";
import { purgeCache } from "./cache.ts";
import {
  createISGCacheKey,
  getDefaultCache,
  regenerateCloudflareISGPage,
} from "./runtime-isg-cache.ts";
import type { ISGManifest, RenderISGPage } from "./runtime-types.ts";

export async function handleCloudflareRevalidationEndpoint(
  request: Request,
  env: Record<string, unknown>,
  app: PrachtApp,
  isgManifest: ISGManifest,
  renderISGPage: RenderISGPage,
  edgeCacheEnabled: boolean,
): Promise<Response> {
  const parsed = await readRevalidationRequest(
    request,
    typeof env[PRACHT_REVALIDATE_TOKEN_ENV] === "string"
      ? (env[PRACHT_REVALIDATE_TOKEN_ENV] as string)
      : undefined,
  );
  if (!parsed.ok) return parsed.response;

  const cache = getDefaultCache();
  if (!cache) {
    return jsonResponse(
      {
        error: "Cloudflare Cache API is unavailable.",
        failed: [],
        revalidated: [],
        skipped: parsed.paths,
      },
      503,
    );
  }

  const report = new RevalidationReport();

  for (const pathname of parsed.paths) {
    try {
      const entry = isgManifest[pathname];
      const skip = classifyRevalidationSkip(
        entry && { render: "isg", revalidate: entry.revalidate },
        entry !== undefined,
        matchAppRoute(app, pathname)?.route ?? null,
      );
      if (skip) {
        report.skipped(pathname, skip);
        continue;
      }

      const cacheKey = createISGCacheKey(request, pathname);
      // A failed regeneration keeps the existing cached copy and is reported
      // in `failed` instead of aborting the whole batch with a 500.
      if (await regenerateCloudflareISGPage(cache, cacheKey, pathname, request, renderISGPage)) {
        report.revalidated(pathname);
        // Routes with both a time and a webhook policy are served through
        // Workers Caching when the `cache` option is on — the edge copy must
        // be purged too, or it keeps serving the old page until its TTL. A
        // purge failure keeps the path in `revalidated` (the worker-managed
        // copy is fresh); the edge falls back to its time window.
        if (edgeCacheEnabled && getTimeRevalidateSeconds(entry.revalidate) !== null) {
          try {
            await purgeCache({ pathPrefixes: [pathname] });
          } catch (err) {
            console.error(`ISG edge cache purge failed for ${pathname}:`, err);
          }
        }
      } else {
        report.failed(pathname, "regeneration_failed");
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      report.failed(pathname, "regeneration_error");
    }
  }

  return jsonResponse(report.toJSON());
}
