import { buildHref } from "./app.ts";
import type { BuildHrefOptions, HrefFn, HrefRouteDefinition } from "./types.ts";

export function createHref(routes: readonly HrefRouteDefinition[]): HrefFn {
  return ((routeId: string, options?: BuildHrefOptions) =>
    buildHref(routes, routeId, options as never)) as HrefFn;
}
