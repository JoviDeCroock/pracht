import type {
  ApiRouteMatch,
  BuildHrefOptions,
  GroupDefinition,
  GroupMeta,
  HrefArgs,
  HrefRouteDefinition,
  ModuleRef,
  ResolvedApiRoute,
  ResolvedRoute,
  ResolvedPrachtApp,
  RouteConfig,
  RouteDefinition,
  RouteId,
  RouteMatch,
  RouteMeta,
  RouteParams,
  RouteSegment,
  RouteTreeNode,
  SearchParamsInput,
  TimeRevalidatePolicy,
  PrachtApp,
  PrachtAppConfig,
} from "./types.ts";
import { formatUnknownNameError } from "./name-suggestions.ts";

interface InheritedRouteConfig {
  pathPrefix: string;
  shell?: string;
  render?: ResolvedRoute["render"];
  middleware: string[];
}

export function timeRevalidate(seconds: number): TimeRevalidatePolicy {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("timeRevalidate expects a positive integer number of seconds.");
  }

  return {
    kind: "time",
    seconds,
  };
}

export function route(path: string, file: ModuleRef, meta?: RouteMeta): RouteDefinition;
export function route(path: string, config: RouteConfig): RouteDefinition;
export function route(
  path: string,
  fileOrConfig: ModuleRef | RouteConfig,
  meta: RouteMeta = {},
): RouteDefinition {
  if (typeof fileOrConfig === "string" || typeof fileOrConfig === "function") {
    return {
      kind: "route",
      path: normalizeRoutePath(path),
      file: resolveModuleRef(fileOrConfig),
      ...meta,
    };
  }

  const { component, loader, ...routeMeta } = fileOrConfig;
  return {
    kind: "route",
    path: normalizeRoutePath(path),
    file: resolveModuleRef(component),
    loaderFile: resolveModuleRef(loader),
    hasLoader: !!loader,
    ...routeMeta,
  };
}

/**
 * Resolve a ModuleRef to a string file path.
 * When the vite plugin is active, import functions are transformed to strings
 * at build time, so this typically receives strings. When called without the
 * transform, unresolved function refs are rejected.
 */
function resolveModuleRef(ref: ModuleRef): string;
function resolveModuleRef(ref: ModuleRef | undefined): string | undefined;
function resolveModuleRef(ref: ModuleRef | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "string") return ref;
  throw new Error(
    "Invalid ModuleRef: expected a string path, but received a function at runtime. " +
      'Use a plain string path (e.g. "./routes/home.tsx"), or ensure the Vite plugin rewrites inline `() => import("./file")` refs in the app manifest.',
  );
}

export function group(meta: GroupMeta, routes: RouteTreeNode[]): GroupDefinition {
  return {
    kind: "group",
    meta,
    routes,
  };
}

export function defineApp(config: PrachtAppConfig): PrachtApp {
  return {
    shells: resolveModuleRefRecord(config.shells ?? {}),
    middleware: resolveModuleRefRecord(config.middleware ?? {}),
    api: config.api ?? {},
    routes: config.routes,
    viewTransitions: config.viewTransitions,
  };
}

function resolveModuleRefRecord(record: Record<string, ModuleRef>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveModuleRef(value);
  }
  return result;
}

export function resolveApp(app: PrachtApp): ResolvedPrachtApp {
  const routes: ResolvedRoute[] = [];
  const inherited: InheritedRouteConfig = {
    pathPrefix: "/",
    middleware: [],
  };

  for (const name of app.api?.middleware ?? []) {
    if (!hasOwnEntry(app.middleware, name)) {
      throw new Error(
        formatUnknownNameError({
          kind: "middleware",
          kindPlural: "middleware",
          name,
          registered: Object.keys(app.middleware),
          context: "api routes",
        }),
      );
    }
  }

  for (const node of app.routes) {
    flattenRouteNode(app, node, inherited, routes);
  }

  return {
    shells: app.shells,
    middleware: app.middleware,
    api: app.api,
    routes,
    apiRoutes: [],
    viewTransitions: app.viewTransitions,
  };
}

export function matchAppRoute(
  app: PrachtApp | ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const resolved = isResolvedApp(app) ? app : resolveApp(app);
  const normalizedPathname = normalizeRoutePath(pathname);
  const targetSegments = splitPathSegments(normalizedPathname);

  for (const currentRoute of resolved.routes) {
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

function flattenRouteNode(
  app: PrachtApp,
  node: RouteTreeNode,
  inherited: InheritedRouteConfig,
  routes: ResolvedRoute[],
): void {
  if (node.kind === "group") {
    const nextInherited: InheritedRouteConfig = {
      pathPrefix: mergeRoutePaths(inherited.pathPrefix, node.meta.pathPrefix),
      shell: node.meta.shell ?? inherited.shell,
      render: node.meta.render ?? inherited.render,
      middleware: [...inherited.middleware, ...(node.meta.middleware ?? [])],
    };

    for (const child of node.routes) {
      flattenRouteNode(app, child, nextInherited, routes);
    }

    return;
  }

  const fullPath = mergeRoutePaths(inherited.pathPrefix, node.path);
  const shell = node.shell ?? inherited.shell;
  const middleware = [...inherited.middleware, ...(node.middleware ?? [])];

  if (shell !== undefined && !hasOwnEntry(app.shells, shell)) {
    throw new Error(
      formatUnknownNameError({
        kind: "shell",
        name: shell,
        registered: Object.keys(app.shells),
        context: `route "${fullPath}"`,
      }),
    );
  }

  routes.push({
    id: node.id ?? createRouteId(fullPath),
    path: fullPath,
    file: node.file,
    loaderFile: node.loaderFile,
    hasLoader: node.loaderFile ? true : node.hasLoader,
    shell,
    shellFile: shell !== undefined ? app.shells[shell] : undefined,
    render: node.render ?? inherited.render,
    middleware,
    middlewareFiles: middleware.map((name) => {
      if (!hasOwnEntry(app.middleware, name)) {
        throw new Error(
          formatUnknownNameError({
            kind: "middleware",
            kindPlural: "middleware",
            name,
            registered: Object.keys(app.middleware),
            context: `route "${fullPath}"`,
          }),
        );
      }
      return app.middleware[name];
    }),
    prefetch: node.prefetch,
    revalidate: node.revalidate,
    segments: parseRouteSegments(fullPath),
  });
}

/** `in` would also match `Object.prototype` keys such as `constructor`. */
function hasOwnEntry(record: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, name);
}

function isResolvedApp(app: PrachtApp | ResolvedPrachtApp): app is ResolvedPrachtApp {
  return app.routes.length === 0 || "segments" in app.routes[0];
}

function matchRouteSegments(
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

function parseRouteSegments(path: string): RouteSegment[] {
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

function splitPathSegments(path: string): string[] {
  return normalizeRoutePath(path).split("/").filter(Boolean);
}

function assertSafeStaticRouteSegment(segment: string): void {
  if (segment === "." || segment === "..") {
    throw new Error(`Unsafe static route segment "${segment}" is not allowed.`);
  }

  if (segment.includes("\0") || /[\r\n\\]/.test(segment)) {
    throw new Error(`Unsafe static route segment "${segment}" contains a forbidden character.`);
  }
}

function mergeRoutePaths(prefix: string, path?: string): string {
  if (!path) {
    return normalizeRoutePath(prefix);
  }

  const normalizedPrefix = normalizeRoutePath(prefix);
  const normalizedPath = normalizeRoutePath(path);

  if (normalizedPrefix === "/") {
    return normalizedPath;
  }

  if (normalizedPath === "/") {
    return normalizedPrefix;
  }

  return normalizeRoutePath(`${normalizedPrefix}/${normalizedPath.slice(1)}`);
}

function normalizeRoutePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");

  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
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
    throw new Error(
      formatUnknownNameError({
        kind: "pracht route id",
        kindPlural: "route ids",
        name: routeId,
        registered: routes.flatMap((candidate) => (candidate.id ? [candidate.id] : [])),
      }),
    );
  }

  const segments = route.segments ?? parseRouteSegments(route.path);
  const params = normalizeHrefParams(segments, options.params ?? {});
  const path = buildPathFromSegments(segments, params);
  return `${path}${serializeSearch(options.search)}${serializeHash(options.hash)}`;
}

function normalizeHrefParams(
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

function serializeSearch(search: SearchParamsInput | undefined): string {
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

/**
 * Convert a list of file paths from `import.meta.glob` into resolved API routes.
 *
 * Example: `"/src/api/health.ts"` → path `/api/health`
 *          `"/src/api/users/[id].ts"` → path `/api/users/:id`
 *          `"/src/api/files/[...path].ts"` → path `/api/files/*`
 *          `"/src/api/index.ts"` → path `/api`
 */
export function resolveApiRoutes(files: string[], apiDir: string = "/src/api"): ResolvedApiRoute[] {
  const normalizedDir = apiDir.replace(/\/$/, "");

  return files
    .map((file) => {
      // Strip the apiDir prefix and file extension
      let relative = file;
      if (relative.startsWith(normalizedDir)) {
        relative = relative.slice(normalizedDir.length);
      }
      relative = relative.replace(/\.(ts|tsx|js|jsx)$/, "");

      // index files map to the parent directory
      if (relative.endsWith("/index")) {
        relative = relative.slice(0, -"/index".length) || "/";
      }

      relative = relative.replace(/\[\.\.\.[^\]]+\]/g, "*");
      relative = relative.replace(/\[([^\]]+)\]/g, ":$1");

      const path = normalizeRoutePath(`/api${relative}`);

      return {
        path,
        file,
        segments: parseRouteSegments(path),
      };
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
    if (params) {
      return {
        route,
        params,
        pathname: normalizedPathname,
      };
    }
  }

  return undefined;
}

function createRouteId(path: string): string {
  if (path === "/") {
    return "index";
  }

  return path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (segment === "*") {
        return "splat";
      }

      return segment.startsWith(":") ? segment.slice(1) : segment;
    })
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-");
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
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
  }

  return left.path.localeCompare(right.path);
}

function getRouteSegmentSpecificity(segment: RouteSegment): number {
  if (segment.type === "static") return 3;
  if (segment.type === "param") return 2;
  return 1;
}
