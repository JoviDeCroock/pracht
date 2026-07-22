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
  RouteSegment,
  RouteTreeNode,
  SpeculationOption,
  TimeRevalidatePolicy,
  WebhookRevalidatePolicy,
  PrachtApp,
  PrachtAppConfig,
} from "./types.ts";
import { formatUnknownNameError } from "./name-suggestions.ts";
import {
  matchResolvedRoute,
  matchRouteSegments,
  normalizeRoutePath,
  parseRouteSegments,
  splitPathSegments,
} from "./route-matching.ts";

export { buildHref, buildPathFromSegments } from "./route-matching.ts";

// Manifest validation is a dev/build-time aid: `import.meta.env.DEV` is
// statically `false` in production Vite bundles, so this folds to `false`
// and every validation branch (plus the error formatting it references) is
// dead-code-eliminated from client builds. In Node (CLI builds, tests)
// `import.meta.env` is undefined and validation stays on — `pracht build`
// runs `resolveApp` there, so invalid manifests still fail the build.
const VALIDATE_MANIFEST = import.meta.env?.DEV !== false;

interface InheritedRouteConfig {
  pathPrefix: string;
  shell?: string;
  render?: ResolvedRoute["render"];
  hydration?: ResolvedRoute["hydration"];
  loaderCache?: ResolvedRoute["loaderCache"];
  middleware: string[];
  speculation?: SpeculationOption;
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

export function webhookRevalidate(): WebhookRevalidatePolicy {
  return {
    kind: "webhook",
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
    constraints: config.constraints,
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

  if (VALIDATE_MANIFEST) {
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
    constraints: app.constraints,
    viewTransitions: app.viewTransitions,
  };
}

export function matchAppRoute(
  app: PrachtApp | ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const resolved = isResolvedApp(app) ? app : resolveApp(app);
  return matchResolvedRoute(resolved, pathname);
}

function flattenRouteNode(
  app: PrachtApp,
  node: RouteTreeNode,
  inherited: InheritedRouteConfig,
  routes: ResolvedRoute[],
): void {
  if (node.kind === "group") {
    const pathPrefix = mergeRoutePaths(inherited.pathPrefix, node.meta.pathPrefix);
    if (VALIDATE_MANIFEST) {
      assertValidLoaderCache(node.meta.loaderCache, `group at "${pathPrefix}"`);
    }
    const nextInherited: InheritedRouteConfig = {
      pathPrefix,
      shell: node.meta.shell ?? inherited.shell,
      render: node.meta.render ?? inherited.render,
      hydration: node.meta.hydration ?? inherited.hydration,
      loaderCache: node.meta.loaderCache ?? inherited.loaderCache,
      middleware: [...inherited.middleware, ...(node.meta.middleware ?? [])],
      speculation: node.meta.speculation ?? inherited.speculation,
    };

    for (const child of node.routes) {
      flattenRouteNode(app, child, nextInherited, routes);
    }

    return;
  }

  const fullPath = mergeRoutePaths(inherited.pathPrefix, node.path);
  const shell = node.shell ?? inherited.shell;
  const middleware = [...inherited.middleware, ...(node.middleware ?? [])];
  const render = node.render ?? inherited.render;
  const hydration = node.hydration ?? inherited.hydration;
  const loaderCache = node.loaderCache ?? inherited.loaderCache;

  if (VALIDATE_MANIFEST) {
    assertValidLoaderCache(node.loaderCache, `route "${fullPath}"`);

    if (render === "spa" && hydration !== undefined && hydration !== "full") {
      throw new Error(
        `Route "${fullPath}" combines render: "spa" with hydration: "${hydration}". ` +
          "SPA routes render entirely in the browser and always use full hydration — " +
          'remove the hydration option or use render: "ssg" / "isg" / "ssr".',
      );
    }

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
  }

  routes.push({
    id: node.id ?? createRouteId(fullPath),
    path: fullPath,
    file: node.file,
    loaderFile: node.loaderFile,
    hasLoader: node.loaderFile ? true : node.hasLoader,
    shell,
    shellFile: shell !== undefined ? app.shells[shell] : undefined,
    render,
    hydration,
    loaderCache,
    middleware,
    middlewareFiles: middleware.map((name) => {
      if (VALIDATE_MANIFEST && !hasOwnEntry(app.middleware, name)) {
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
    speculation: node.speculation ?? inherited.speculation,
    segments: parseRouteSegments(fullPath),
  });
}

function assertValidLoaderCache(loaderCache: ResolvedRoute["loaderCache"], context: string): void {
  if (
    loaderCache !== undefined &&
    loaderCache !== false &&
    (!Number.isInteger(loaderCache) || loaderCache < 0)
  ) {
    throw new Error(
      `Invalid loaderCache for ${context}: expected false or a non-negative integer number of seconds.`,
    );
  }
}

/** `in` would also match `Object.prototype` keys such as `constructor`. */
function hasOwnEntry(record: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, name);
}

function isResolvedApp(app: PrachtApp | ResolvedPrachtApp): app is ResolvedPrachtApp {
  return app.routes.length === 0 || "segments" in app.routes[0];
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
