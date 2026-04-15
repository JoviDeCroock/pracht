import type {
  ApiRouteMatch,
  GroupDefinition,
  GroupMeta,
  ModuleRef,
  ResolvedApiRoute,
  ResolvedRoute,
  ResolvedPrachtApp,
  RouteConfig,
  RouteDefinition,
  RouteMatch,
  RouteMeta,
  RouteParams,
  RouteSegment,
  RouteTreeNode,
  TimeRevalidatePolicy,
  PrachtApp,
  PrachtAppConfig,
} from "./types.ts";

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
    ...routeMeta,
  };
}

/**
 * Resolve a ModuleRef to a string file path.
 * When the vite plugin is active, import functions are transformed to strings
 * at build time, so this typically receives strings. When called without the
 * transform (e.g. in tests), functions pass through as empty strings.
 */
function resolveModuleRef(ref: ModuleRef): string;
function resolveModuleRef(ref: ModuleRef | undefined): string | undefined;
function resolveModuleRef(ref: ModuleRef | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "string") return ref;
  // Function refs are transformed to strings by the vite plugin.
  // Without the plugin, we can't extract the path — return empty string.
  return "";
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

  for (const node of app.routes) {
    flattenRouteNode(app, node, inherited, routes);
  }

  return {
    shells: app.shells,
    middleware: app.middleware,
    api: app.api,
    routes,
    apiRoutes: [],
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

  routes.push({
    id: node.id ?? createRouteId(fullPath),
    path: fullPath,
    file: node.file,
    loaderFile: node.loaderFile,
    shell,
    shellFile: shell ? app.shells[shell] : undefined,
    render: node.render ?? inherited.render,
    middleware,
    middlewareFiles: middleware.flatMap((name) => {
      const middlewareFile = app.middleware[name];
      return middlewareFile ? [middlewareFile] : [];
    }),
    revalidate: node.revalidate,
    segments: parseRouteSegments(fullPath),
  });
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
      params[currentSegment.name] = targetSegments.slice(targetIndex).join("/");
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

    if (segment.startsWith(":")) {
      return {
        type: "param",
        name: segment.slice(1),
      } as const;
    }

    return {
      type: "static",
      value: segment,
    } as const;
  });
}

function splitPathSegments(path: string): string[] {
  return normalizeRoutePath(path).split("/").filter(Boolean);
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

export function buildPathFromSegments(segments: RouteSegment[], params: RouteParams): string {
  const parts = segments.map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return encodeURIComponent(params[segment.name] ?? "");
    // catchall
    return params["*"] ?? "";
  });

  return normalizeRoutePath("/" + parts.join("/"));
}

/**
 * Convert a list of file paths from `import.meta.glob` into resolved API routes.
 *
 * Example: `"/src/api/health.ts"` → path `/api/health`
 *          `"/src/api/users/[id].ts"` → path `/api/users/:id`
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

      // Convert [param] to :param for consistency with page routes
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
