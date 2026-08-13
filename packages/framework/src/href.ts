import { buildHrefUntyped } from "./route-href.ts";
import type { BuildHrefOptions, HrefFn, HrefRouteDefinition } from "./types.ts";

export function createHref(routes: readonly HrefRouteDefinition[]): HrefFn {
  return ((routeId: string, options?: BuildHrefOptions) =>
    buildHrefUntyped(routes, routeId, options)) as HrefFn;
}
