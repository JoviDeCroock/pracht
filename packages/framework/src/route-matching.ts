/**
 * Pure route matching, path, and href primitives.
 *
 * This module is the only part of the manifest machinery the client router
 * needs at runtime. It must NOT import `resolveApp` or the manifest DSL —
 * keeping it dependency-free lets production client builds tree-shake the
 * manifest resolution and validation code in `app.ts` that only ever needs
 * to run in dev and at build time.
 */

import { formatUnknownNameError } from "./name-suggestions.ts";
import type {
  BuildHrefOptions,
  HrefArgs,
  HrefRouteDefinition,
  ResolvedPrachtApp,
  RouteId,
  RouteMatch,
  RouteParams,
  RouteSegment,
  SearchParamsInput,
} from "./types.ts";

export function normalizeRoutePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");

  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

export function splitPathSegments(path: string): string[] {
  return normalizeRoutePath(path).split("/").filter(Boolean);
}

export function parseRouteSegments(path: string): RouteSegment[] {
  return splitPathSegments(path).map((segment) => {
    if (segment === "*") {
      return {
        type: "catchall",
        name: "*",
      } as const;
    }

    if (segment.startsWith(":") && segment.endsWith("*")) {
      return {
        type: "catchall",
        name: segment.slice(1, -1) || "*",
      } as const;
    }

    if (segment.startsWith(":")) {
      return {
        type: "param",
        name: segment.slice(1),
      } as const;
    }

    assertSafeStaticRouteSegment(segment);
    return {
      type: "static",
      value: segment,
    } as const;
  });
}

function assertSafeStaticRouteSegment(segment: string): void {
  if (segment === "." || segment === "..") {
    throw new Error(`Unsafe static route segment "${segment}" is not allowed.`);
  }

  if (segment.includes("\0") || /[\r\n\\]/.test(segment)) {
    throw new Error(`Unsafe static route segment "${segment}" contains a forbidden character.`);
  }
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
    if (typeof targetSegment === "undefined") {
      return null;
    }

    if (currentSegment.type === "static") {
      if (currentSegment.value !== targetSegment) {
        return null;
      }
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

/**
 * Match a pathname against an already-resolved app. The client router always
 * holds a `ResolvedPrachtApp`, so unlike `matchAppRoute` this never falls
 * back to `resolveApp` — that fallback would drag manifest resolution and
 * validation into every production client bundle.
 */
export function matchResolvedRoute(
  app: ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const normalizedPathname = normalizeRoutePath(pathname);
  const targetSegments = splitPathSegments(normalizedPathname);

  for (const currentRoute of app.routes) {
    const params = matchRouteSegments(currentRoute.segments, targetSegments);
    if (params) {
      return {
        route: currentRoute,
        params,
        pathname: normalizedPathname,
      };
    }
  }

  return undefined;
}

export function buildPathFromSegments(
  segments: readonly RouteSegment[],
  params: RouteParams,
): string {
  const parts = segments.map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return encodeDynamicPathSegment(params[segment.name] ?? "");
    // Catch-all routes preserve `/` between captured components, but each
    // component is encoded as its own filesystem-safe URL segment.
    const raw = params[segment.name] ?? params["*"] ?? "";
    return raw
      .split("/")
      .map((part) => encodeDynamicPathSegment(part))
      .join("/");
  });

  return normalizeRoutePath("/" + parts.join("/"));
}

export function buildHref<TRoute extends RouteId>(
  routes: readonly HrefRouteDefinition[],
  routeId: TRoute,
  ...args: HrefArgs<TRoute>
): string {
  return buildHrefUntyped(routes, String(routeId), args[0] as BuildHrefOptions | undefined);
}

function buildHrefUntyped(
  routes: readonly HrefRouteDefinition[],
  routeId: string,
  options: BuildHrefOptions = {},
): string {
  const route = routes.find((candidate) => candidate.id === routeId);
  if (!route) {
    // The rich "did you mean" error only exists where import.meta.env.DEV is
    // not statically false (dev server, tests, Node CLI); production builds
    // constant-fold the guard and tree-shake the error formatting away.
    if (import.meta.env?.DEV !== false) {
      throw new Error(
        formatUnknownNameError({
          kind: "pracht route id",
          kindPlural: "route ids",
          name: routeId,
          registered: routes.flatMap((candidate) => (candidate.id ? [candidate.id] : [])),
        }),
      );
    }
    throw new Error(`Unknown pracht route id "${routeId}".`);
  }

  const segments = route.segments ?? parseRouteSegments(route.path);
  const params = normalizeHrefParams(segments, options.params ?? {});
  const path = buildPathFromSegments(segments, params);
  return `${path}${serializeSearch(options.search)}${serializeHash(options.hash)}`;
}

export function normalizeHrefParams(
  segments: readonly RouteSegment[],
  params: Record<string, unknown>,
): RouteParams {
  const expected = new Set(
    segments
      .filter((segment) => segment.type === "param" || segment.type === "catchall")
      .map((segment) => segment.name),
  );

  for (const name of expected) {
    if (params[name] == null) {
      throw new Error(`Missing route param: ${name}.`);
    }
  }

  for (const name of Object.keys(params)) {
    if (!expected.has(name)) {
      throw new Error(`Unexpected route param: ${name}.`);
    }
  }

  const normalized: RouteParams = {};
  for (const name of expected) {
    normalized[name] = String(params[name]);
  }
  return normalized;
}

export function serializeSearch(search: SearchParamsInput | undefined): string {
  if (search == null) return "";

  if (typeof search === "string") {
    if (!search) return "";
    return search.startsWith("?") ? search : `?${search}`;
  }

  const params = search instanceof URLSearchParams ? search : objectToSearchParams(search);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function objectToSearchParams(search: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        appendSearchValue(params, key, item);
      }
      continue;
    }

    appendSearchValue(params, key, value);
  }
  return params;
}

function appendSearchValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value == null) return;
  params.append(key, String(value));
}

function serializeHash(hash: string | undefined): string {
  if (!hash) return "";
  return hash.startsWith("#") ? hash : `#${hash}`;
}

/**
 * Encode one dynamic URL path segment for SSG/ISG output. `encodeURIComponent`
 * leaves unreserved characters (including `.`) intact, and even percent-encoded
 * dot segments are normalized by URL parsers. Reject exact `.` / `..` segments
 * instead of allowing them to reach filesystem output path construction.
 */
function encodeDynamicPathSegment(part: string): string {
  if (part === "." || part === "..") {
    throw new Error(`Unsafe dynamic route param segment "${part}" is not allowed.`);
  }
  return encodeURIComponent(part);
}
