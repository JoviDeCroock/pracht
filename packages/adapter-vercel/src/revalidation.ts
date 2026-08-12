import {
  classifyRevalidationSkip,
  jsonResponse,
  matchAppRoute,
  PRACHT_REVALIDATE_TOKEN_ENV,
  readRevalidationRequest,
  RevalidationReport,
  resolveRevalidationToken,
  type PrachtApp,
} from "@pracht/core/server";

/** Cache statuses that prove Vercel actually refreshed the prerender output. */
const VERCEL_CACHE_REFRESH_STATUSES = new Set(["MISS", "REVALIDATED", "BYPASS"]);

export async function handleVercelRevalidationEndpoint(
  request: Request,
  app: PrachtApp,
): Promise<Response> {
  const token = getRuntimeRevalidationToken();
  const parsed = await readRevalidationRequest(request, token);
  if (!parsed.ok) return parsed.response;

  const report = new RevalidationReport();

  for (const pathname of parsed.paths) {
    const match = matchAppRoute(app, pathname);
    // Vercel matches route patterns rather than a prerender manifest, so a
    // matched ISG route always has somewhere to write.
    const skip = classifyRevalidationSkip(match?.route, match !== null);
    if (skip) {
      report.skipped(pathname, skip);
      continue;
    }

    // A failed regeneration keeps the prior cached output and is recorded per
    // path rather than aborting the entire batch.
    try {
      const revalidateUrl = new URL(pathname, request.url);
      const response = await fetch(revalidateUrl, {
        headers: {
          accept: "text/html",
          "x-prerender-revalidate": token!,
        },
        method: "GET",
      });

      if (!response.ok) {
        report.failed(pathname, `upstream_status_${response.status}`);
        continue;
      }

      // A 200 is insufficient when the bypass token is wrong: Vercel can
      // return the old HIT/STALE document without regenerating anything. An
      // absent header remains successful for non-Vercel and test environments.
      const cacheStatus = response.headers.get("x-vercel-cache");
      if (cacheStatus === null || VERCEL_CACHE_REFRESH_STATUSES.has(cacheStatus.toUpperCase())) {
        report.revalidated(pathname);
      } else {
        console.error(
          `ISG webhook revalidation failed for ${pathname}: x-vercel-cache was "${cacheStatus}" — ` +
            "the revalidation token did not match the build-time bypass token; " +
            `rebuild with ${PRACHT_REVALIDATE_TOKEN_ENV} set.`,
        );
        report.failed(pathname, "prerender_cache_not_bypassed");
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      report.failed(pathname, "regeneration_error");
    }
  }

  return jsonResponse(report.toJSON());
}

function getRuntimeRevalidationToken(): string | undefined {
  // Keep this as a call into @pracht/core. An inline process.env read is
  // collapsed by the application build's define and would fail every request.
  return resolveRevalidationToken();
}
