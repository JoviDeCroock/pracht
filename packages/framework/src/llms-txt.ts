/**
 * llms.txt generation (https://llmstxt.org) from the resolved app graph.
 *
 * `pracht build` writes the result to `dist/client/llms.txt` and the dev SSR
 * middleware serves it live at `/llms.txt` when the vite plugin's `llmsTxt`
 * option is enabled. Output is deterministic: entries are sorted by path and
 * dynamic SSG/ISG routes are expanded through their `getStaticPaths()`
 * export. Dynamic routes without enumerable instances (e.g. SSR routes with
 * params) are skipped — they have no concrete URL an agent could fetch.
 */

import { buildPathFromSegments } from "./app.ts";
import { API_METHOD_ORDER } from "./app-graph.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  ApiRouteModule,
  ModuleRegistry,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteModule,
  RouteParams,
} from "./types.ts";

export type LlmsTxtSection = "pages" | "api";

export interface BuildLlmsTxtOptions {
  app: ResolvedPrachtApp;
  apiRoutes?: readonly ResolvedApiRoute[];
  registry?: ModuleRegistry;
  /** H1 project title — the only required llms.txt element. */
  title: string;
  /** Blockquote summary rendered under the title. Omitted when empty. */
  description?: string;
  /**
   * Origin (e.g. "https://example.com") prepended to every link so the file
   * contains absolute URLs. Links stay root-relative when omitted.
   */
  origin?: string;
  /** Sections to emit. Defaults to both "pages" and "api". */
  include?: readonly LlmsTxtSection[];
}

interface LlmsTxtPageEntry {
  path: string;
  /** True when the route module exports a server-only `markdown` string. */
  markdown: boolean;
}

interface LlmsTxtApiEntry {
  path: string;
  methods: string[];
}

export async function buildLlmsTxt(options: BuildLlmsTxtOptions): Promise<string> {
  const include = options.include ?? ["pages", "api"];
  const origin = options.origin?.replace(/\/$/, "") ?? "";

  const lines: string[] = [`# ${options.title}`];
  if (options.description) {
    lines.push("", `> ${options.description}`);
  }

  if (include.includes("pages")) {
    const pages = await collectPageEntries(options.app.routes, options.registry);
    if (pages.length > 0) {
      lines.push("", "## Pages", "");
      for (const page of pages) {
        const note = page.markdown ? ": supports `Accept: text/markdown`" : "";
        lines.push(`- [${page.path}](${origin}${page.path})${note}`);
      }
    }
  }

  if (include.includes("api")) {
    const apiEntries = await collectApiEntries(options.apiRoutes ?? [], options.registry);
    if (apiEntries.length > 0) {
      lines.push("", "## API", "");
      for (const entry of apiEntries) {
        const note = entry.methods.length > 0 ? `: ${entry.methods.join(", ")}` : "";
        lines.push(`- [${entry.path}](${origin}${entry.path})${note}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
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

async function collectPageEntries(
  routes: readonly ResolvedRoute[],
  registry: ModuleRegistry | undefined,
): Promise<LlmsTxtPageEntry[]> {
  const entries = new Map<string, LlmsTxtPageEntry>();

  for (const route of routes) {
    const routeModule = await loadRouteModule(registry, route.file);
    const markdown = typeof routeModule?.markdown === "string";

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

async function collectApiEntries(
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
