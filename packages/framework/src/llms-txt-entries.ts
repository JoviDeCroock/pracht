import { API_METHOD_ORDER } from "./api-export-detection.ts";
import { buildPathFromSegments } from "./route-href.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { hasMarkdownRepresentation } from "./runtime-negotiation.ts";
import type {
  ApiRouteModule,
  ModuleRegistry,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteModule,
  RouteParams,
} from "./types.ts";

declare const __PRACHT_AGENT_SURFACE__: boolean | undefined;

export interface LlmsTxtPageEntry {
  path: string;
  /** True when the route declares or exports a Markdown representation. */
  markdown: boolean;
}

export interface LlmsTxtApiEntry {
  path: string;
  methods: string[];
}

export interface LlmsTxtCapabilityEntry {
  name: string;
  path: string;
  description: string;
  effect: string;
}

function isDynamicRoute(route: ResolvedRoute): boolean {
  return route.segments.some((segment) => segment.type === "param" || segment.type === "catchall");
}

/** Locale-independent path ordering so output is byte-stable across machines. */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

async function loadRouteModule(
  registry: ModuleRegistry | undefined,
  file: string,
): Promise<RouteModule | undefined> {
  try {
    return await resolveRegistryModule<RouteModule>(registry?.routeModules, file);
  } catch {
    return undefined;
  }
}

export async function collectLlmsTxtPageEntries(
  routes: readonly ResolvedRoute[],
  registry: ModuleRegistry | undefined,
): Promise<LlmsTxtPageEntry[]> {
  const entries = new Map<string, LlmsTxtPageEntry>();

  for (const route of routes) {
    const routeModule = await loadRouteModule(registry, route.file);
    const markdown = hasMarkdownRepresentation(route, routeModule);

    if (!isDynamicRoute(route)) {
      if (!entries.has(route.path)) {
        entries.set(route.path, { markdown, path: route.path });
      }
      continue;
    }

    // Dynamic routes only have concrete URLs when they are SSG/ISG with a
    // getStaticPaths() export — list each prerendered instance. Other dynamic
    // routes (SSR/SPA params) have no enumerable URLs and are skipped.
    if (route.render !== "ssg" && route.render !== "isg") continue;
    if (typeof routeModule?.getStaticPaths !== "function") continue;

    let paramSets: RouteParams[];
    try {
      paramSets = await routeModule.getStaticPaths();
    } catch {
      continue;
    }

    for (const params of paramSets) {
      const path = buildPathFromSegments(route.segments, params);
      if (!entries.has(path)) {
        entries.set(path, { markdown, path });
      }
    }
  }

  return [...entries.values()].sort((left, right) => comparePaths(left.path, right.path));
}

export async function collectLlmsTxtApiEntries(
  apiRoutes: readonly ResolvedApiRoute[],
  registry: ModuleRegistry | undefined,
): Promise<LlmsTxtApiEntry[]> {
  const entries: LlmsTxtApiEntry[] = [];

  for (const route of apiRoutes) {
    let apiModule: ApiRouteModule | undefined;
    try {
      apiModule = await resolveRegistryModule<ApiRouteModule>(registry?.apiModules, route.file);
    } catch {
      apiModule = undefined;
    }

    const methods = apiModule
      ? API_METHOD_ORDER.filter((method) => typeof apiModule[method] === "function")
      : [];
    entries.push({ methods, path: route.path });
  }

  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

// Only HTTP-exposed capabilities are listed — private ones have no URL an
// agent could call, and webmcp exposure requires expose.http anyway. Invalid
// capability registrations propagate as errors, matching HTTP dispatch and
// `pracht inspect` rather than silently emitting an incomplete file.
export async function collectLlmsTxtCapabilityEntries(
  app: ResolvedPrachtApp,
  registry: ModuleRegistry | undefined,
): Promise<LlmsTxtCapabilityEntry[]> {
  if (!registry?.capabilityModules) return [];
  if (Object.keys(app.capabilities ?? {}).length === 0) return [];
  // Production builds that prove the app has no agent surface replace this
  // branch with `return []`, so enabling llms.txt for pages/API discovery does
  // not retain the capability dispatch runtime in the deployed server.
  if (typeof __PRACHT_AGENT_SURFACE__ !== "undefined" && !__PRACHT_AGENT_SURFACE__) return [];

  const { resolveAppCapabilities } = await import("./runtime-capabilities.ts");
  const resolved = await resolveAppCapabilities(app, registry);
  const entries: LlmsTxtCapabilityEntry[] = [];
  for (const { name, capability, httpPath } of resolved) {
    if (!httpPath) continue;
    entries.push({
      description: capability.description ?? "",
      effect: capability.effect,
      name,
      path: httpPath,
    });
  }

  return entries.sort((left, right) => comparePaths(left.name, right.name));
}
