import type { ResolvedPrachtApp, RouteMatch, RouteParams, RouteSegment } from "./types.ts";

export function normalizeRoutePath(path: string): string {
  if (!path || path === "/") return "/";
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

export function splitPathSegments(path: string): string[] {
  return normalizeRoutePath(path).split("/").filter(Boolean);
}

export function parseRouteSegments(path: string): RouteSegment[] {
  return splitPathSegments(path).map((segment) => {
    if (segment === "*") return { type: "catchall", name: "*" } as const;
    if (segment.startsWith(":") && segment.endsWith("*")) {
      return { type: "catchall", name: segment.slice(1, -1) || "*" } as const;
    }
    if (segment.startsWith(":")) {
      return { type: "param", name: segment.slice(1) } as const;
    }
    assertSafeStaticRouteSegment(segment);
    return { type: "static", value: segment } as const;
  });
}

export function matchRouteSegments(
  routeSegments: RouteSegment[],
  targetSegments: string[],
): RouteParams | null {
  const params: RouteParams = {};
  let routeIndex = 0;
  let targetIndex = 0;

  while (routeIndex < routeSegments.length) {
    const currentSegment = routeSegments[routeIndex];
    if (currentSegment.type === "catchall") {
      try {
        params[currentSegment.name] = targetSegments
          .slice(targetIndex)
          .map(decodeURIComponent)
          .join("/");
      } catch {
        return null;
      }
      return params;
    }

    const targetSegment = targetSegments[targetIndex];
    if (typeof targetSegment === "undefined") return null;
    if (currentSegment.type === "static") {
      if (currentSegment.value !== targetSegment) return null;
    } else {
      try {
        params[currentSegment.name] = decodeURIComponent(targetSegment);
      } catch {
        return null;
      }
    }
    routeIndex += 1;
    targetIndex += 1;
  }

  return targetIndex === targetSegments.length ? params : null;
}

/** Match a pathname without retaining manifest resolution in client bundles. */
export function matchResolvedRoute(
  app: ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const normalizedPathname = normalizeRoutePath(pathname);
  const targetSegments = splitPathSegments(normalizedPathname);
  for (const currentRoute of app.routes) {
    const params = matchRouteSegments(currentRoute.segments, targetSegments);
    if (params) return { route: currentRoute, params, pathname: normalizedPathname };
  }
  return undefined;
}

function assertSafeStaticRouteSegment(segment: string): void {
  if (segment === "." || segment === "..") {
    throw new Error(`Unsafe static route segment "${segment}" is not allowed.`);
  }
  if (segment.includes("\0") || /[\r\n\\]/.test(segment)) {
    throw new Error(`Unsafe static route segment "${segment}" contains a forbidden character.`);
  }
}
