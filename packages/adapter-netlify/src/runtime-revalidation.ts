import {
  classifyRevalidationSkip,
  jsonResponse,
  matchAppRoute,
  readRevalidationRequest,
  RevalidationReport,
  resolveRevalidationToken,
  type ISGManifestEntry,
} from "@pracht/core/server";

import { netlifyRouteCacheTag } from "./runtime-cache.ts";
import { normalizePathname } from "./runtime-path.ts";
import type {
  NetlifyExecutionContext,
  NetlifyHandlerOptions,
  NetlifyPurgeCacheOptions,
} from "./types.ts";

/** Purge Netlify's cache without making applications depend on the platform SDK directly. */
export async function purgeNetlifyCache(options?: NetlifyPurgeCacheOptions): Promise<void> {
  const { purgeCache } = await import("@netlify/functions");
  await purgeCache(options);
}

export async function handleNetlifyRevalidation<
  TNetlifyContext extends NetlifyExecutionContext,
  TContext,
>(
  request: Request,
  options: NetlifyHandlerOptions<TNetlifyContext, TContext>,
  isgManifest: Record<string, ISGManifestEntry>,
): Promise<Response> {
  const parsed = await readRevalidationRequest(request, resolveRevalidationToken());
  if (!parsed.ok) return parsed.response;

  const report = new RevalidationReport();
  for (const pathname of parsed.paths) {
    const canonicalPathname = normalizePathname(pathname);
    const entry = isgManifest[canonicalPathname];
    const matched = matchAppRoute(options.app, canonicalPathname)?.route ?? null;
    const reason = classifyRevalidationSkip(
      entry ? { ...entry, render: "isg" } : undefined,
      Boolean(entry),
      matched,
    );
    if (reason) {
      report.skipped(pathname, reason);
      continue;
    }
    if (!options.purgeCache) {
      report.failed(pathname, "cache_purge_unavailable");
      continue;
    }

    try {
      await options.purgeCache({ tags: [netlifyRouteCacheTag(canonicalPathname)] });
      report.revalidated(pathname);
    } catch (error) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, error);
      report.failed(pathname, "cache_purge_failed");
    }
  }

  return jsonResponse(report.toJSON());
}
