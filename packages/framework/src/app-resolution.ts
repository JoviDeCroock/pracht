import { validateAgentsConfig } from "./app-agent-validation.ts";
import {
  assertCompatibleRouteRendering,
  assertKnownGroupMeta,
  assertKnownRouteNode,
  assertRegisteredManifestName,
  assertValidLoaderCache,
  VALIDATE_MANIFEST,
} from "./app-validation.ts";
import { normalizeRoutePath, parseRouteSegments } from "./route-pattern.ts";
import { NOT_FOUND_ROUTE_ID, NOT_FOUND_ROUTE_PATH } from "./runtime-constants.ts";
import type {
  PrachtApp,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteTreeNode,
  SpeculationOption,
} from "./types.ts";

interface InheritedRouteConfig {
  pathPrefix: string;
  shell?: string;
  render?: ResolvedRoute["render"];
  hydration?: ResolvedRoute["hydration"];
  loaderCache?: ResolvedRoute["loaderCache"];
  middleware: string[];
  speculation?: SpeculationOption;
}

/** Resolve the authored route tree into the flat runtime application graph. */
export function resolveApp(app: PrachtApp): ResolvedPrachtApp {
  const routes: ResolvedRoute[] = [];
  const inherited: InheritedRouteConfig = { pathPrefix: "/", middleware: [] };

  if (VALIDATE_MANIFEST) {
    for (const name of app.api?.middleware ?? []) {
      assertRegisteredManifestName(app.middleware, name, {
        kind: "middleware",
        kindPlural: "middleware",
        context: "api routes",
      });
    }
  }

  // Security validation stays outside the dev-only manifest guard so a
  // production compilation can never tree-shake a trust-policy check.
  validateAgentsConfig(app.agents);
  for (const node of app.routes) flattenRouteNode(app, node, inherited, routes);

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

/** Resolve the out-of-table not-found page through the normal page shape. */
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
    for (const child of node.routes) flattenRouteNode(app, child, nextInherited, routes);
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

function mergeRoutePaths(prefix: string, path?: string): string {
  if (!path) return normalizeRoutePath(prefix);
  const normalizedPrefix = normalizeRoutePath(prefix);
  const normalizedPath = normalizeRoutePath(path);
  if (normalizedPrefix === "/") return normalizedPath;
  if (normalizedPath === "/") return normalizedPrefix;
  return normalizeRoutePath(`${normalizedPrefix}/${normalizedPath.slice(1)}`);
}

function createRouteId(path: string): string {
  if (path === "/") return "index";
  return path
    .slice(1)
    .split("/")
    .map((segment) =>
      segment === "*" ? "splat" : segment.startsWith(":") ? segment.slice(1) : segment,
    )
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-");
}
