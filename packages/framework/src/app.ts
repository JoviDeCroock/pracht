import type {
  GroupDefinition,
  GroupMeta,
  ModuleRef,
  NotFoundConfig,
  NotFoundDefinition,
  ResolvedRoute,
  ResolvedPrachtApp,
  RouteConfig,
  RouteDefinition,
  RouteMatch,
  RouteMeta,
  RouteTreeNode,
  SpeculationOption,
  TimeRevalidatePolicy,
  WebhookRevalidatePolicy,
  PrachtApp,
  PrachtAppConfig,
} from "./types.ts";
import { validateAgentsConfig } from "./app-agent-validation.ts";
import {
  assertCompatibleRouteRendering,
  assertKnownGroupMeta,
  assertKnownNotFoundConfig,
  assertKnownRouteNode,
  assertRegisteredManifestName,
  assertValidLoaderCache,
  VALIDATE_MANIFEST,
} from "./app-validation.ts";
import { NOT_FOUND_ROUTE_ID, NOT_FOUND_ROUTE_PATH } from "./runtime-constants.ts";
import { matchResolvedRoute, normalizeRoutePath, parseRouteSegments } from "./route-matching.ts";

export { buildHref, buildPathFromSegments } from "./route-matching.ts";
export { matchApiRoute, resolveApiRoutes } from "./api-routes.ts";

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
    capabilities: resolveModuleRefRecord(config.capabilities ?? {}),
    agents: config.agents,
    api: config.api ?? {},
    routes: config.routes,
    notFound: resolveNotFoundDefinition(config.notFound),
    constraints: config.constraints,
    viewTransitions: config.viewTransitions,
  };
}

function resolveNotFoundDefinition(
  notFound: ModuleRef | NotFoundConfig | undefined,
): NotFoundDefinition | undefined {
  if (notFound === undefined) return undefined;

  if (typeof notFound === "string" || typeof notFound === "function") {
    return { file: resolveModuleRef(notFound) };
  }

  assertKnownNotFoundConfig(notFound);

  const { component, loader, ...meta } = notFound;
  return {
    file: resolveModuleRef(component),
    loaderFile: resolveModuleRef(loader),
    hasLoader: loader ? true : undefined,
    ...meta,
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
      assertRegisteredManifestName(app.middleware, name, {
        kind: "middleware",
        kindPlural: "middleware",
        context: "api routes",
      });
    }
  }

  // Security validation, deliberately OUTSIDE the VALIDATE_MANIFEST guard:
  // Vite compiles `import.meta.env.DEV` to `false` in production server/edge
  // bundles, which would strip a dev-only check and let a typo'd policy
  // (e.g. "requre") silently fail open at dispatch. This runs once per
  // manifest resolution, so the cost is negligible.
  validateAgentsConfig(app.agents);

  for (const node of app.routes) {
    flattenRouteNode(app, node, inherited, routes);
  }

  return {
    shells: app.shells,
    middleware: app.middleware,
    capabilities: app.capabilities ?? {},
    agents: app.agents,
    api: app.api,
    routes,
    apiRoutes: [],
    notFound: resolveNotFoundRoute(app),
    constraints: app.constraints,
    viewTransitions: app.viewTransitions,
  };
}

/**
 * Shape the not-found page like a `ResolvedRoute` so the runtime and the
 * client router can render it through the normal pipeline. It inherits
 * nothing from groups (it sits outside the route tree), always renders on
 * demand (`ssr` — never prerendered), and its `segments` are empty because
 * matching never reaches it.
 */
function resolveNotFoundRoute(app: PrachtApp): ResolvedRoute | undefined {
  const notFound = app.notFound;
  if (!notFound) return undefined;

  const middleware = notFound.middleware ?? [];

  if (VALIDATE_MANIFEST && notFound.shell !== undefined) {
    assertRegisteredManifestName(app.shells, notFound.shell, {
      kind: "shell",
      context: "the notFound page",
    });
  }

  return {
    id: NOT_FOUND_ROUTE_ID,
    path: NOT_FOUND_ROUTE_PATH,
    file: notFound.file,
    loaderFile: notFound.loaderFile,
    hasLoader: notFound.loaderFile ? true : notFound.hasLoader,
    shell: notFound.shell,
    shellFile: notFound.shell !== undefined ? app.shells[notFound.shell] : undefined,
    render: "ssr",
    hydration: notFound.hydration,
    middleware,
    middlewareFiles: middleware.map((name) => {
      if (VALIDATE_MANIFEST) {
        assertRegisteredManifestName(app.middleware, name, {
          kind: "middleware",
          kindPlural: "middleware",
          context: "the notFound page",
        });
      }
      return app.middleware[name];
    }),
    segments: [],
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
    assertKnownGroupMeta(node.meta, `group at "${pathPrefix}"`);
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
  assertKnownRouteNode(node, `route "${fullPath}"`);
  const shell = node.shell ?? inherited.shell;
  const middleware = [...inherited.middleware, ...(node.middleware ?? [])];
  const render = node.render ?? inherited.render;
  const hydration = node.hydration ?? inherited.hydration;
  const loaderCache = node.loaderCache ?? inherited.loaderCache;

  if (VALIDATE_MANIFEST) {
    assertValidLoaderCache(node.loaderCache, `route "${fullPath}"`);
    assertCompatibleRouteRendering(render, hydration, fullPath);

    if (shell !== undefined) {
      assertRegisteredManifestName(app.shells, shell, {
        kind: "shell",
        context: `route "${fullPath}"`,
      });
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
    markdown: node.markdown,
    middleware,
    middlewareFiles: middleware.map((name) => {
      if (VALIDATE_MANIFEST) {
        assertRegisteredManifestName(app.middleware, name, {
          kind: "middleware",
          kindPlural: "middleware",
          context: `route "${fullPath}"`,
        });
      }
      return app.middleware[name];
    }),
    prefetch: node.prefetch,
    revalidate: node.revalidate,
    speculation: node.speculation ?? inherited.speculation,
    segments: parseRouteSegments(fullPath),
  });
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
