import type {
  ResolvedRoute,
  ResolvedPrachtApp,
  RouteMatch,
  RouteTreeNode,
  SpeculationOption,
  PrachtApp,
} from "./types.ts";
import { validateAgentsConfig } from "./app-agent-validation.ts";
import {
  assertCompatibleRouteRendering,
  assertKnownGroupMeta,
  assertKnownRouteNode,
  assertRegisteredManifestName,
  assertValidLoaderCache,
  VALIDATE_MANIFEST,
} from "./app-validation.ts";
import { NOT_FOUND_ROUTE_ID, NOT_FOUND_ROUTE_PATH } from "./runtime-constants.ts";
import { matchResolvedRoute, normalizeRoutePath, parseRouteSegments } from "./route-pattern.ts";

export { buildHref, buildPathFromSegments } from "./route-href.ts";
export { matchApiRoute, resolveApiRoutes } from "./api-routes.ts";
export { defineApp, group, route, timeRevalidate, webhookRevalidate } from "./app-definition.ts";

interface InheritedRouteConfig {
  pathPrefix: string;
  shell?: string;
  render?: ResolvedRoute["render"];
  hydration?: ResolvedRoute["hydration"];
  loaderCache?: ResolvedRoute["loaderCache"];
  middleware: string[];
  speculation?: SpeculationOption;
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
