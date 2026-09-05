/**
 * Pure route matching, path, and href primitives.
 *
 * This module is the only part of the manifest machinery the client router
 * needs at runtime. It must NOT import `resolveApp` or the manifest DSL —
 * keeping it dependency-free lets production client builds tree-shake the
 * manifest resolution and validation code in `app.ts` that only ever needs
 * to run in dev and at build time.
 */

import { withBase } from "./base.ts";
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
  UntypedRouteTarget,
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

/** Match one declared route pattern against a concrete pathname. */
export function matchRoutePath(pattern: string, pathname: string): RouteParams | null {
  return matchRouteSegments(parseRouteSegments(pattern), splitPathSegments(pathname));
}

/** Whether a declared route pattern contains a parameter or catch-all segment. */
export function routePathIsDynamic(pattern: string): boolean {
  return parseRouteSegments(pattern).some((segment) => segment.type !== "static");
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

interface CompiledHrefRoute {
  segments: readonly RouteSegment[];
  parameterNames: readonly string[];
  parameterNameSet?: ReadonlySet<string>;
  staticPath?: string;
}

interface CompiledHrefRoutes {
  byId: ReadonlyMap<string, CompiledHrefRoute>;
  registeredIds: readonly string[];
}

// The browser's route table is small enough that retaining the straightforward
// resolver costs fewer shipped bytes. Server bundles compile instead: the
// table is shared across requests, where link-heavy renders make repeated
// scans and path intermediates expensive. Plain Node (tests and custom SSR)
// has no import.meta.env, so it takes the server path too.
const COMPILE_HREF_ROUTES = import.meta.env?.SSR !== false;
let compiledHrefRouteTables:
  | WeakMap<readonly HrefRouteDefinition[], CompiledHrefRoutes>
  | undefined;

function getCompiledHrefRoutes(routes: readonly HrefRouteDefinition[]): CompiledHrefRoutes {
  const cache = (compiledHrefRouteTables ??= new WeakMap());
  const cached = cache.get(routes);
  if (cached) return cached;

  const byId = new Map<string, CompiledHrefRoute>();
  const registeredIds: string[] = [];

  for (const route of routes) {
    const id = route.id;
    if (id === undefined) continue;
    if (id) registeredIds.push(id);
    // Preserve Array.find()'s first-match behavior for a malformed table with
    // duplicate ids. Manifest validation normally rejects this earlier.
    if (byId.has(id)) continue;

    const segments = route.segments ?? parseRouteSegments(route.path);
    const parameterNames: string[] = [];
    for (const segment of segments) {
      if (segment.type !== "static") parameterNames.push(segment.name);
    }

    byId.set(id, {
      segments,
      parameterNames,
      parameterNameSet: parameterNames.length > 0 ? new Set(parameterNames) : undefined,
      // Every caller hands this path to a browser, so it carries the deploy
      // base. Dynamic paths are based after their parameters are substituted.
      staticPath:
        parameterNames.length === 0 ? withBase(buildPathFromSegments(segments, {})) : undefined,
    });
  }

  const compiled = { byId, registeredIds };
  cache.set(routes, compiled);
  return compiled;
}

export function buildHref<TRoute extends RouteId>(
  routes: readonly HrefRouteDefinition[],
  routeId: TRoute,
  ...args: HrefArgs<TRoute>
): string {
  return buildHrefUntyped(routes, String(routeId), args[0] as BuildHrefOptions | undefined);
}

/** @internal Build a route URL before application route registration narrows `RouteId`. */
export function buildHrefUntyped(
  routes: readonly HrefRouteDefinition[],
  routeId: string,
  options: Omit<UntypedRouteTarget, "route"> = {},
): string {
  if (COMPILE_HREF_ROUTES) {
    return buildCompiledHref(routes, routeId, options.params, options.search, options.hash);
  }

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
  // Every caller — <Link>, navigate(), prefetch(), href() — hands this to the
  // browser, so it is a URL path and carries the deploy base. Prerender output
  // paths use `buildPathFromSegments` directly and stay base-free.
  const path = withBase(buildPathFromSegments(segments, params));
  return `${path}${serializeSearch(options.search as SearchParamsInput | undefined)}${serializeHash(options.hash)}`;
}

function buildCompiledHref(
  routes: readonly HrefRouteDefinition[],
  routeId: string,
  params: Record<string, unknown> | undefined,
  search: unknown,
  hash: string | undefined,
): string {
  const compiledRoutes = getCompiledHrefRoutes(routes);
  const route = compiledRoutes.byId.get(routeId);
  if (!route) throwUnknownRoute(routeId, compiledRoutes.registeredIds);
  validateCompiledHrefParams(route, params);
  const path = route.staticPath ?? withBase(buildCompiledHrefPath(route.segments, params!));
  const searchSuffix = serializeSearch(search as SearchParamsInput | undefined);
  const hashSuffix = serializeHash(hash);
  return searchSuffix || hashSuffix ? `${path}${searchSuffix}${hashSuffix}` : path;
}

function throwUnknownRoute(routeId: string, registeredIds: readonly string[]): never {
  // The rich "did you mean" error only exists where import.meta.env.DEV is
  // not statically false (dev server, tests, Node CLI); production builds
  // constant-fold the guard and tree-shake the error formatting away.
  if (import.meta.env?.DEV !== false) {
    throw new Error(
      formatUnknownNameError({
        kind: "pracht route id",
        kindPlural: "route ids",
        name: routeId,
        registered: registeredIds,
      }),
    );
  }
  throw new Error(`Unknown pracht route id "${routeId}".`);
}

function validateCompiledHrefParams(
  route: CompiledHrefRoute,
  params: Record<string, unknown> | undefined,
): void {
  for (const name of route.parameterNames) {
    if (params?.[name] == null) throw new Error(`Missing route param: ${name}.`);
  }

  if (!params) return;
  for (const name in params) {
    if (Object.prototype.hasOwnProperty.call(params, name) && !route.parameterNameSet?.has(name)) {
      throw new Error(`Unexpected route param: ${name}.`);
    }
  }
}

function buildCompiledHrefPath(
  segments: readonly RouteSegment[],
  params: Readonly<Record<string, unknown>>,
): string {
  let path = "";
  for (const segment of segments) {
    if (segment.type === "static") {
      path = appendCompiledPathPart(path, segment.value);
      continue;
    }

    const raw = String(params[segment.name]);
    if (segment.type === "param") {
      path = appendCompiledPathPart(path, encodeDynamicPathSegment(raw));
      continue;
    }

    let partStart = 0;
    for (let index = 0; index <= raw.length; index += 1) {
      if (index !== raw.length && raw.charCodeAt(index) !== 47) continue;
      path = appendCompiledPathPart(path, encodeDynamicPathSegment(raw.slice(partStart, index)));
      partStart = index + 1;
    }
  }
  return path || "/";
}

function appendCompiledPathPart(path: string, part: string): string {
  return part ? `${path}/${part}` : path;
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
