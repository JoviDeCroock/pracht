import type { BaseRouteArgs } from "@pracht/core";
import { purgeCache, routeCacheTag } from "@pracht/adapter-cloudflare/cache";

// Webhook-based ISG revalidation: purge the cached /pricing page so the next
// request re-renders it. Pages cached through Workers Caching are tagged
// with `pracht:route:<id>`; `purgeCache` also accepts path prefixes or
// `purgeEverything`.
//
// The webhook is protected with a shared secret so strangers cannot purge
// the cache (or run up render costs): set it with
// `wrangler secret put REVALIDATE_SECRET` (or in `.dev.vars` locally) and
// send it in the `x-revalidate-secret` header.
export async function POST({ request, context }: BaseRouteArgs) {
  const secret = (context.env as { REVALIDATE_SECRET?: string }).REVALIDATE_SECRET;
  if (!secret || request.headers.get("x-revalidate-secret") !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { route } = (await request.json()) as { route?: string };
  if (!route) {
    return Response.json({ error: "Missing route id" }, { status: 400 });
  }

  await purgeCache({ tags: [routeCacheTag(route)] });
  return Response.json({ revalidated: route });
}
