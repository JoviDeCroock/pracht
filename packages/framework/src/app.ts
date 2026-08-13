/** Stable application authoring, resolution, and matching facade. */

export { defineApp, group, route, timeRevalidate, webhookRevalidate } from "./app-definition.ts";
export { matchAppRoute } from "./app-matching.ts";
export { resolveApp } from "./app-resolution.ts";
export { matchApiRoute, resolveApiRoutes } from "./api-routes.ts";
export { buildHref, buildPathFromSegments } from "./route-href.ts";
