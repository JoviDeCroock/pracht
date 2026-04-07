import type {
  ApiRouteMatch,
  GroupDefinition,
  GroupMeta,
  ResolvedApiRoute,
  ResolvedRoute,
  ResolvedViactApp,
  RouteConfig,
  RouteDefinition,
  RouteMatch,
  RouteMeta,
  RouteParams,
  RouteSegment,
  RouteTreeNode,
  TimeRevalidatePolicy,
  ViactApp,
  ViactAppConfig,
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

export function route(path: string, file: string, meta?: RouteMeta): RouteDefinition;
export function route(path: string, config: RouteConfig): RouteDefinition;
export function route(
  path: string,
  fileOrConfig: string | RouteConfig,
  meta: RouteMeta = {},
): RouteDefinition {
  if (typeof fileOrConfig === "string") {
    return {
      kind: "route",
      path: normalizeRoutePath(path),
      file: fileOrConfig,
      ...meta,
    };
  }

  const { component, loader, ...routeMeta } = fileOrConfig;
  return {
    kind: "route",
    path: normalizeRoutePath(path),
    file: component,
    loaderFile: loader,
    ...routeMeta,
  };
}

export function group(meta: GroupMeta, routes: RouteTreeNode[]): GroupDefinition {
  return {
    kind: "group",
    meta,
    routes,
  };
}

export function defineApp(config: ViactAppConfig): ViactApp {
  return {
    shells: config.shells ?? {},
    middleware: config.middleware ?? {},
    api: config.api ?? {},
    routes: config.routes,
  };
}

export function resolveApp(app: ViactApp): ResolvedViactApp {
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
  app: ViactApp | ResolvedViactApp,
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
  app: ViactApp,
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

function isResolvedApp(app: ViactApp | ResolvedViactApp): app is ResolvedViactApp {
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
      params[currentSegment.name] = decodeURIComponent(targetSegment);
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

// ---------------------------------------------------------------------------
// API Routes — file-based auto-discovery
// ---------------------------------------------------------------------------

/**
 * Convert a list of file paths from `import.meta.glob` into resolved API routes.
 *
 * Example: `"/src/api/health.ts"` → path `/api/health`
 *          `"/src/api/users/[id].ts"` → path `/api/users/:id`
 *          `"/src/api/index.ts"` → path `/api`
 */
export function resolveApiRoutes(files: string[], apiDir: string = "/src/api"): ResolvedApiRoute[] {
  const normalizedDir = apiDir.replace(/\/$/, "");

  return files.map((file) => {
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
  });
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
