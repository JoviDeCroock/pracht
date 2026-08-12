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
  PrachtAgentsConfig,
} from "./types.ts";
import { isValidCapabilityHttpPath } from "@pracht/capabilities";
import { formatUnknownNameError } from "./name-suggestions.ts";
import { NOT_FOUND_ROUTE_ID, NOT_FOUND_ROUTE_PATH } from "./runtime-constants.ts";
import { matchResolvedRoute, normalizeRoutePath, parseRouteSegments } from "./route-matching.ts";

export { buildHref, buildPathFromSegments } from "./route-matching.ts";
export { matchApiRoute, resolveApiRoutes } from "./api-routes.ts";

// Manifest validation is a dev/build-time aid: `import.meta.env.DEV` is
// statically `false` in production Vite bundles, so this folds to `false`
// and every validation branch (plus the error formatting it references) is
// dead-code-eliminated from client builds. In Node (CLI builds, tests)
// `import.meta.env` is undefined and validation stays on — `pracht build`
// runs `resolveApp` there, so invalid manifests still fail the build.
const VALIDATE_MANIFEST = import.meta.env?.DEV !== false;

// Server-side only. Vite sets `import.meta.env.SSR` to `false` in client
// bundles (and leaves `import.meta.env` undefined under plain Node, where the
// CLI and tests run), so this folds to `false` in the browser build and the
// key lists, the walk, and `formatUnknownNameError` are dead-code-eliminated.
// Unlike `VALIDATE_MANIFEST` it stays on in production *server* bundles, which
// is where a fail-open manifest key actually matters.
const VALIDATE_META_KEYS = import.meta.env?.SSR !== false;

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

  assertKnownMetaKeys(notFound, NOT_FOUND_CONFIG_KEYS, "the notFound page");

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

  if (
    VALIDATE_MANIFEST &&
    notFound.shell !== undefined &&
    !hasOwnEntry(app.shells, notFound.shell)
  ) {
    throw new Error(
      formatUnknownNameError({
        kind: "shell",
        name: notFound.shell,
        registered: Object.keys(app.shells),
        context: "the notFound page",
      }),
    );
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
      if (VALIDATE_MANIFEST && !hasOwnEntry(app.middleware, name)) {
        throw new Error(
          formatUnknownNameError({
            kind: "middleware",
            kindPlural: "middleware",
            name,
            registered: Object.keys(app.middleware),
            context: "the notFound page",
          }),
        );
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
    assertKnownMetaKeys(node.meta, GROUP_META_KEYS, `group at "${pathPrefix}"`);
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
  // `resolveApp()` is idempotent — the build re-resolves an already-resolved
  // app (see `prerenderApp`). Resolved routes carry derived fields
  // (`segments`, `shellFile`, `middlewareFiles`) that are not author-supplied
  // meta, so only validate authored nodes.
  if (!isResolvedRouteNode(node)) {
    assertKnownMetaKeys(node, ROUTE_NODE_KEYS, `route "${fullPath}"`);
  }
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
    markdown: node.markdown,
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

const ROUTE_META_KEYS = [
  "hasLoader",
  "hydration",
  "id",
  "loaderCache",
  "markdown",
  "middleware",
  "prefetch",
  "render",
  "revalidate",
  "shell",
  "speculation",
];
const ROUTE_NODE_KEYS = [...ROUTE_META_KEYS, "file", "kind", "loaderFile", "path"];
const GROUP_META_KEYS = [
  "hydration",
  "loaderCache",
  "middleware",
  "pathPrefix",
  "render",
  "shell",
  "speculation",
];
const NOT_FOUND_CONFIG_KEYS = ["component", "hydration", "loader", "middleware", "shell"];

/**
 * Reject meta keys the resolver does not read.
 *
 * Runs whenever the manifest is resolved on a server — including production
 * server/edge bundles, where `VALIDATE_MANIFEST` folds to `false`. That guard
 * is wrong for this check: `group({ middlewares: ["auth"] })` or
 * `route(..., { middlware: ["auth"] })` used to resolve to a route with no
 * middleware at all, and every static check (`pracht verify`, `doctor`,
 * `requireMiddleware` constraints, the graph snapshot) still reported the
 * route as guarded.
 *
 * It is gated on `VALIDATE_META_KEYS` rather than shipped everywhere, because
 * the browser cannot catch anything here: `resolveApp()` runs client-side on a
 * manifest the server already accepted, so the check would be pure bundle
 * weight (~300 bytes gzip, plus it re-anchors `formatUnknownNameError` in the
 * shared chunk).
 *
 * TypeScript rejects an inline object literal with an unknown key, but excess-
 * property checking does not apply to a meta object built separately and
 * passed by reference, and the manifest is also read by JavaScript callers and
 * by builds that never run `tsc`.
 */
/** A route node that already went through `resolveApp()`. */
function isResolvedRouteNode(node: object): boolean {
  return "segments" in node;
}

function assertKnownMetaKeys(meta: object, allowed: string[], context: string): void {
  if (!VALIDATE_META_KEYS) return;

  for (const key of Object.keys(meta)) {
    if (allowed.includes(key)) continue;
    throw new Error(
      formatUnknownNameError({
        kind: "option",
        kindPlural: "options",
        name: key,
        registered: allowed,
        context,
      }),
    );
  }
}

const AGENT_POLICY_MODES = ["observe", "require"];
const CONFIRMATION_MODES = ["token", "human"];

/**
 * Validate `defineApp({ agents })`. The security-relevant setting — the Web
 * Bot Auth `policy` — is compared with `=== "require"` at dispatch, so a typo
 * (`"requre"`) would silently fail open. Reject unknown policies and
 * non-positive numeric trust settings so the manifest fails closed instead.
 */
function validateAgentsConfig(agents: PrachtAgentsConfig | undefined): void {
  if (!agents) return;
  const { webBotAuth, confirmation, mcp } = agents;
  if (webBotAuth) {
    if (webBotAuth.policy !== undefined && !AGENT_POLICY_MODES.includes(webBotAuth.policy)) {
      throw new Error(
        `defineApp({ agents.webBotAuth.policy }) must be one of ${AGENT_POLICY_MODES.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(webBotAuth.policy)}.`,
      );
    }
    for (const key of [
      "clockSkewSeconds",
      "maxLifetimeSeconds",
      "directoryCacheTtlSeconds",
    ] as const) {
      assertPositiveNumber(webBotAuth[key], `agents.webBotAuth.${key}`);
    }
  }
  if (confirmation) {
    if (confirmation.mode !== undefined && !CONFIRMATION_MODES.includes(confirmation.mode)) {
      throw new Error(
        `defineApp({ agents.confirmation.mode }) must be one of ${CONFIRMATION_MODES.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(confirmation.mode)}.`,
      );
    }
    assertPositiveNumber(confirmation.ttlSeconds, "agents.confirmation.ttlSeconds");
  }
  if (mcp?.path !== undefined && !isValidCapabilityHttpPath(mcp.path)) {
    throw new Error(
      'defineApp({ agents.mcp.path }) must be an exact same-origin pathname starting with "/".',
    );
  }
}

function assertPositiveNumber(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `defineApp({ ${label} }) must be a positive number, got ${JSON.stringify(value)}.`,
    );
  }
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
