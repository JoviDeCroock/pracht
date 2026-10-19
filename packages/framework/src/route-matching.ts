/**
 * Pure route matching, path, and href primitives.
 *
 * This module is the only part of the manifest machinery the client router
 * needs at runtime. It must NOT import `resolveApp` or the manifest DSL —
 * keeping it dependency-free lets production client builds tree-shake the
 * manifest resolution and validation code in `app.ts` that only ever needs
 * to run in dev and at build time.
 */

import { applyTrailingSlash, withBase } from "./base.ts";

// `pracht({ trailingSlash })`. Declared in this module rather than imported:
// Rolldown folds the condition only within a module, so an imported flag would
// keep the policy code in every multi-chunk build of an app on the default.
declare const __PRACHT_TRAILING_SLASH__: string | undefined;
const TRAILING_SLASH_ENABLED =
  typeof __PRACHT_TRAILING_SLASH__ !== "undefined" && __PRACHT_TRAILING_SLASH__ !== "ignore";
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

/**
 * `matchResolvedRoute` without the scan, for the server. Every request matches
 * against the whole table, where a linear scan costs microseconds per route at
 * a thousand routes, so the table is indexed once and reused. Only the
 * request pipeline calls it. The client router and the public `matchAppRoute`
 * (also exported to the browser) keep `matchResolvedRoute`: they match once
 * per navigation, and the index would cost shipped bytes. Vite folds
 * `import.meta.env?.SSR` before tree-shaking, so a flag would also drop it
 * there; the separate export keeps it out of browser bundles Vite never built.
 */
export function matchIndexedResolvedRoute(
  app: ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const normalizedPathname = normalizeRoutePath(pathname);
  const match = matchIndexedRoute(app.routes, splitPathSegments(normalizedPathname));
  return match && { route: match.route, params: match.params, pathname: normalizedPathname };
}

let routeIndexes: WeakMap<readonly RouteDefinitionWithSegments[], SegmentIndex> | undefined;

type RouteDefinitionWithSegments = ResolvedPrachtApp["routes"][number];

/**
 * First-match semantics without the scan: the routes the index says could
 * match, tried in declaration order.
 */
function matchIndexedRoute(
  routes: readonly RouteDefinitionWithSegments[],
  targetSegments: string[],
): { route: RouteDefinitionWithSegments; params: RouteParams } | undefined {
  const cache = (routeIndexes ??= new WeakMap());
  let index = cache.get(routes);
  if (!index) cache.set(routes, (index = indexSegments(routes)));
  for (const position of index.candidates(targetSegments)) {
    const params = matchRouteSegments(routes[position]!.segments, targetSegments);
    if (params) return { route: routes[position]!, params };
  }
  return undefined;
}

// --- Route-pattern algebra -------------------------------------------------
// Questions about patterns rather than one URL: does one pattern match every
// URL another does (manifest conflict warnings), could two match the same URL
// (the islands-navigation table), and which patterns could match a URL at all
// (the server's index). Each answer follows `matchRouteSegments` exactly: a
// static segment matches its own spelling, a parameter one segment that
// percent-decodes, and a catch-all the rest of the path (none of it, too) if
// every segment decodes. Segments after a catch-all never take part.

/** Whether `segment` percent-decodes, which a parameter or catch-all requires. */
function decodes(segment: string): boolean {
  try {
    decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
}

/** Whether a URL segment exists that both `a` and `b` match at one position. */
function segmentsMeet(a: RouteSegment, b: RouteSegment): boolean {
  if (a.type === "static") return b.type === "static" ? a.value === b.value : decodes(a.value);
  return b.type !== "static" || decodes(b.value);
}

/** Whether `segments` from `from` on can match a path of decodable segments only. */
function restDecodes(segments: readonly RouteSegment[], from: number): boolean {
  for (let index = from; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.type === "catchall") return true;
    if (segment.type === "static" && !decodes(segment.value)) return false;
  }
  return true;
}

/** Whether every pathname `later` matches is also matched by `earlier`. */
export function routeCovers(
  earlier: readonly RouteSegment[],
  later: readonly RouteSegment[],
): boolean {
  for (let index = 0; ; index += 1) {
    const segment = earlier[index];
    const other = later[index];
    if (segment?.type === "catchall") return restDecodes(later, index);
    if (segment === undefined || other === undefined) return segment === other;
    if (other.type === "catchall") return false;
    if (segment.type === "static") {
      if (other.type !== "static" || other.value !== segment.value) return false;
    } else if (other.type === "static" && !decodes(other.value)) {
      // A parameter rejects a segment that does not percent-decode, which a
      // static segment such as `100%` still matches literally.
      return false;
    }
  }
}

/** Whether some pathname matches both `a` and `b`. */
export function routesOverlap(a: readonly RouteSegment[], b: readonly RouteSegment[]): boolean {
  for (let index = 0; ; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left?.type === "catchall") return restDecodes(b, index);
    if (right?.type === "catchall") return restDecodes(a, index);
    if (left === undefined || right === undefined) return left === right;
    if (!segmentsMeet(left, right)) return false;
  }
}

/**
 * Patterns indexed by the segment at each position, so a question about one
 * URL or pattern looks at the few patterns that could answer it instead of
 * scanning them all. Ids are assigned in the order patterns are added, and
 * every list of candidates comes back in that order.
 */
export interface SegmentIndex {
  /** Add the next pattern; it gets the next id, starting at 0. */
  add(segments: readonly RouteSegment[]): void;
  /**
   * Every pattern that may match the concrete path `target`: a superset, in id
   * order, for the caller to check with `matchRouteSegments`.
   */
  candidates(target: readonly string[]): number[];
  /**
   * Every pattern that may share a pathname with `pattern`: a superset of the
   * ones `routesOverlap` or `routeCovers` accepts, in id order.
   */
  overlapping(pattern: readonly RouteSegment[]): number[];
}

export function indexSegments(
  routes: readonly { segments: readonly RouteSegment[] }[] = [],
): SegmentIndex {
  // Per position: patterns with that static value there, and patterns with a
  // parameter there. Catch-all patterns are listed apart, with the position
  // of their catch-all, since they accept any segment from there on.
  const staticAt: Map<string, number[]>[] = [];
  const paramAt: number[][] = [];
  const byLength: number[][] = [];
  const catchAlls: number[] = [];
  const catchAllAt: number[] = [];
  let count = 0;

  const add = (segments: readonly RouteSegment[]) => {
    const id = count++;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (segment.type === "catchall") {
        catchAlls.push(id);
        catchAllAt.push(index);
        return;
      }
      if (segment.type === "param") {
        (paramAt[index] ??= []).push(id);
      } else {
        const statics = (staticAt[index] ??= new Map());
        const list = statics.get(segment.value);
        if (list) list.push(id);
        else statics.set(segment.value, [id]);
      }
    }
    (byLength[segments.length] ??= []).push(id);
  };

  /**
   * The narrowest list that holds every pattern able to meet a query of
   * `length` segments (plus a catch-all, when `rest`) whose static segments
   * `staticOf` names, and the catch-all patterns that start early enough.
   */
  const lookup = (
    length: number,
    rest: boolean,
    staticOf: (index: number) => string | undefined,
  ): number[] => {
    let best: number[][] | undefined;
    let bestSize = Infinity;
    // Catch-all patterns from position `upTo` on can meet anything there.
    let upTo = -1;
    if (!rest) {
      best = [byLength[length] ?? []];
      bestSize = best[0]!.length;
      upTo = length;
    }
    for (let index = 0; index < length; index += 1) {
      const value = staticOf(index);
      if (value === undefined) continue;
      const statics = staticAt[index]?.get(value) ?? [];
      const params = paramAt[index] ?? [];
      const size = statics.length + params.length;
      if (size < bestSize) {
        best = [statics, params];
        bestSize = size;
        upTo = index;
      }
    }
    if (!best) {
      // Only parameters before a catch-all: anything may meet it.
      return Array.from({ length: count }, (_, id) => id);
    }
    const early: number[] = [];
    for (let position = 0; position < catchAlls.length; position += 1) {
      if (catchAllAt[position]! <= upTo) early.push(catchAlls[position]!);
    }
    return mergeAscending([...best, early]);
  };

  for (const route of routes) add(route.segments);

  return {
    add,
    candidates: (target) => lookup(target.length, false, (index) => target[index]),
    overlapping(pattern) {
      let length = pattern.findIndex((segment) => segment.type === "catchall");
      const rest = length !== -1;
      if (!rest) length = pattern.length;
      return lookup(length, rest, (index) => {
        const segment = pattern[index]!;
        return segment.type === "static" ? segment.value : undefined;
      });
    },
  };
}

/** Merge ascending id lists into one ascending list without repeats. */
function mergeAscending(lists: readonly (readonly number[])[]): number[] {
  const nonEmpty = lists.filter((list) => list.length > 0);
  if (nonEmpty.length === 1) return nonEmpty[0] as number[];
  const merged: number[] = [];
  const cursors = nonEmpty.map(() => 0);
  for (;;) {
    let next = Infinity;
    for (let list = 0; list < nonEmpty.length; list += 1) {
      const value = nonEmpty[list]![cursors[list]!];
      if (value !== undefined && value < next) next = value;
    }
    if (next === Infinity) return merged;
    merged.push(next);
    for (let list = 0; list < nonEmpty.length; list += 1) {
      if (nonEmpty[list]![cursors[list]!] === next) cursors[list] = cursors[list]! + 1;
    }
  }
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
        parameterNames.length === 0
          ? withBase(
              TRAILING_SLASH_ENABLED
                ? applyTrailingSlash(buildPathFromSegments(segments, {}))
                : buildPathFromSegments(segments, {}),
            )
          : undefined,
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
  // `pracht({ trailingSlash })` picks the spelling; the default folds away.
  const routePath = buildPathFromSegments(segments, params);
  const path = withBase(TRAILING_SLASH_ENABLED ? applyTrailingSlash(routePath) : routePath);
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
  let path = route.staticPath;
  if (path === undefined) {
    const routePath = buildCompiledHrefPath(route.segments, params!);
    path = withBase(TRAILING_SLASH_ENABLED ? applyTrailingSlash(routePath) : routePath);
  }
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

/** Page path → its Markdown file's path: `/about` → `/about.md`, `/` → `/index.md`. */
export function markdownFilePath(pagePath: string): string {
  const trimmed = pagePath.length > 1 ? pagePath.replace(/\/+$/, "") : pagePath;
  return trimmed === "/" || trimmed === "" ? "/index.md" : `${trimmed}.md`;
}
