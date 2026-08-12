import { assertKnownNotFoundConfig } from "./app-validation.ts";
import { normalizeRoutePath } from "./route-matching.ts";
import type {
  GroupDefinition,
  GroupMeta,
  ModuleRef,
  NotFoundConfig,
  NotFoundDefinition,
  PrachtApp,
  PrachtAppConfig,
  RouteConfig,
  RouteDefinition,
  RouteMeta,
  RouteTreeNode,
  TimeRevalidatePolicy,
  WebhookRevalidatePolicy,
} from "./types.ts";

export function timeRevalidate(seconds: number): TimeRevalidatePolicy {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("timeRevalidate expects a positive integer number of seconds.");
  }
  return { kind: "time", seconds };
}

export function webhookRevalidate(): WebhookRevalidatePolicy {
  return { kind: "webhook" };
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

export function group(meta: GroupMeta, routes: RouteTreeNode[]): GroupDefinition {
  return { kind: "group", meta, routes };
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

/** Normalize author-facing module references after the Vite transform. */
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
