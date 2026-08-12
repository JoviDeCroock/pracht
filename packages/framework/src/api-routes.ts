import {
  matchRouteSegments,
  normalizeRoutePath,
  parseRouteSegments,
  splitPathSegments,
} from "./route-matching.ts";
import type { ApiRouteMatch, ResolvedApiRoute, RouteSegment } from "./types.ts";

/**
 * Convert `import.meta.glob` file paths into API route definitions ordered by
 * specificity, so static routes win over params and catch-all routes.
 */
export function resolveApiRoutes(files: string[], apiDir: string = "/src/api"): ResolvedApiRoute[] {
  const normalizedDir = apiDir.replace(/\/$/, "");

  return files
    .filter((file) => !/\.d\.ts$/i.test(file))
    .map((file) => {
      let relative = file;
      if (relative.startsWith(normalizedDir)) {
        relative = relative.slice(normalizedDir.length);
      }
      relative = relative.replace(/\.(ts|tsx|js|jsx)$/, "");

      if (relative.endsWith("/index")) {
        relative = relative.slice(0, -"/index".length) || "/";
      }

      relative = relative.replace(/\[\.\.\.[^\]]+\]/g, "*");
      relative = relative.replace(/\[([^\]]+)\]/g, ":$1");

      const path = normalizeRoutePath(`/api${relative}`);
      return { path, file, segments: parseRouteSegments(path) };
    })
    .sort(compareResolvedApiRoutes);
}

export function matchApiRoute(
  apiRoutes: ResolvedApiRoute[],
  pathname: string,
): ApiRouteMatch | undefined {
  const normalizedPathname = normalizeRoutePath(pathname);
  const targetSegments = splitPathSegments(normalizedPathname);

  for (const route of apiRoutes) {
    const params = matchRouteSegments(route.segments, targetSegments);
    if (params) return { route, params, pathname: normalizedPathname };
  }

  return undefined;
}

function compareResolvedApiRoutes(left: ResolvedApiRoute, right: ResolvedApiRoute): number {
  const length = Math.max(left.segments.length, right.segments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = left.segments[index];
    const rightSegment = right.segments[index];
    if (!leftSegment) return 1;
    if (!rightSegment) return -1;

    const leftScore = getRouteSegmentSpecificity(leftSegment);
    const rightScore = getRouteSegmentSpecificity(rightSegment);
    if (leftScore !== rightScore) return rightScore - leftScore;
  }

  return left.path.localeCompare(right.path);
}

function getRouteSegmentSpecificity(segment: RouteSegment): number {
  if (segment.type === "static") return 3;
  if (segment.type === "param") return 2;
  return 1;
}
