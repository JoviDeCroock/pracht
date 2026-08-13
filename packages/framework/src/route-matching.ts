/**
 * Stable route primitive facade. Pattern parsing/matching and outbound href
 * construction live in separate dependency-light modules for client bundles.
 */

export {
  buildHref,
  buildHrefUntyped,
  buildPathFromSegments,
  normalizeHrefParams,
  serializeSearch,
} from "./route-href.ts";
export {
  matchResolvedRoute,
  matchRouteSegments,
  normalizeRoutePath,
  parseRouteSegments,
  splitPathSegments,
} from "./route-pattern.ts";
