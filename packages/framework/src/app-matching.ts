import { resolveApp } from "./app-resolution.ts";
import { matchResolvedRoute } from "./route-pattern.ts";
import type { PrachtApp, ResolvedPrachtApp, RouteMatch } from "./types.ts";

/** Match either an authored or already-resolved application route graph. */
export function matchAppRoute(
  app: PrachtApp | ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  return matchResolvedRoute(isResolvedApp(app) ? app : resolveApp(app), pathname);
}

function isResolvedApp(app: PrachtApp | ResolvedPrachtApp): app is ResolvedPrachtApp {
  return app.routes.length === 0 || "segments" in app.routes[0];
}
