/**
 * llms.txt generation (https://llmstxt.org) from the resolved app graph.
 *
 * `pracht build` writes the result to `dist/client/llms.txt` and the dev SSR
 * middleware serves it live at `/llms.txt` when the vite plugin's `llmsTxt`
 * option is enabled. Output is deterministic: entries are sorted by path and
 * dynamic SSG/ISG routes are expanded through their `getStaticPaths()`
 * export. Dynamic routes without enumerable instances (e.g. SSR routes with
 * params) are skipped — they have no concrete URL an agent could fetch.
 * HTTP-exposed capabilities are listed with their dispatch endpoint, effect
 * class, and description so agents can discover callable operations, not
 * just readable pages.
 */

import { buildPathFromSegments } from "./app.ts";
import { API_METHOD_ORDER } from "./app-graph.ts";
import { matchRoutePattern } from "./constraints.ts";
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

export type LlmsTxtSection = "pages" | "api" | "capabilities";

declare const __PRACHT_AGENT_SURFACE__: boolean | undefined;

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
  /** Sections to emit. Defaults to "pages", "api", and "capabilities". */
  include?: readonly LlmsTxtSection[];
  /**
   * Route/API path patterns to leave out, using the same segment globs as
   * `defineApp({ constraints })` (`*` = one segment, trailing `**` = the rest).
   *
   * llms.txt is a list of URLs an agent is invited to fetch, so anything an
   * anonymous agent cannot actually use — pages behind an auth middleware,
   * internal tooling, deliberate error routes — belongs here. Patterns are
   * matched against the emitted paths, so a prerendered instance of a dynamic
   * route (`/blog/hello-world`) is covered by `/blog/**`, and a capability is
   * excluded by its dispatch path (`/api/capabilities/**`).
   *
   * Framework-reserved paths (any `_pracht` or `__pracht` segment, such as the
   * `@pracht/image` endpoint at `/api/_pracht/image`) are always omitted and
   * do not need an entry here.
   */
  exclude?: readonly string[];
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

interface LlmsTxtCapabilityEntry {
  name: string;
  path: string;
  description: string;
  effect: string;
}

/**
 * Path segments pracht reserves for its own endpoints. `/api/_pracht/image` is
 * the image-optimization handler the `@pracht/image` loaders post to, and
 * `/__pracht/*` covers the revalidation webhook and devtools. They are
 * framework plumbing, not part of the app's agent surface, so listing them
 * invites agents to call endpoints that are not theirs to call. Users cannot
 * be expected to exclude them by hand in every app.
 */
const RESERVED_PATH_SEGMENTS = new Set(["_pracht", "__pracht"]);

function isReservedPath(path: string): boolean {
  return path.split("/").some((segment) => RESERVED_PATH_SEGMENTS.has(segment));
}

export async function buildLlmsTxt(options: BuildLlmsTxtOptions): Promise<string> {
  const include = options.include ?? ["pages", "api", "capabilities"];
  const origin = options.origin?.replace(/\/$/, "") ?? "";
  const excludesPattern = createExcludeMatcher(options.exclude);
  const isExcluded = (path: string): boolean => isReservedPath(path) || excludesPattern(path);

  const lines: string[] = [`# ${options.title}`];
  if (options.description) {
    lines.push("", `> ${options.description}`);
  }

  if (include.includes("pages")) {
    const pages = (await collectPageEntries(options.app.routes, options.registry)).filter(
      (page) => !isExcluded(page.path),
    );
    if (pages.length > 0) {
      lines.push("", "## Pages", "");
      for (const page of pages) {
        const note = page.markdown ? ": supports `Accept: text/markdown`" : "";
        lines.push(`- [${page.path}](${origin}${page.path})${note}`);
      }
    }
  }

  if (include.includes("api")) {
    const apiEntries = (await collectApiEntries(options.apiRoutes ?? [], options.registry)).filter(
      (entry) => !isExcluded(entry.path),
    );
    if (apiEntries.length > 0) {
      lines.push("", "## API", "");
      for (const entry of apiEntries) {
        const note = entry.methods.length > 0 ? `: ${entry.methods.join(", ")}` : "";
        lines.push(`- [${entry.path}](${origin}${entry.path})${note}`);
      }
    }
  }

  if (include.includes("capabilities")) {
    const capabilityEntries = (
      await collectCapabilityEntries(options.app, options.registry)
    ).filter((entry) => !isExcluded(entry.path));
    if (capabilityEntries.length > 0) {
      lines.push("", "## Capabilities", "");
      for (const entry of capabilityEntries) {
        const confirmation = entry.effect === "destructive" ? ", requires confirmation" : "";
        const description = entry.description ? ` — ${entry.description}` : "";
        lines.push(
          `- [${entry.name}](${origin}${entry.path}): POST (${entry.effect}${confirmation})${description}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Validate every pattern up front, not on first use.
 *
 * `matchRoutePattern` throws for an invalid pattern only when it evaluates it,
 * and `Array.some` short-circuits — so a bad pattern behind a matching one
 * stayed silent until an unrelated route was added, then failed the build.
 * The rewritten message names `llmsTxt.exclude` rather than sending the user
 * to `defineApp({ constraints })`.
 */
function createExcludeMatcher(patterns: readonly string[] | undefined): (path: string) => boolean {
  if (!patterns || patterns.length === 0) return () => false;

  // Validated structurally rather than by probing with a sample path:
  // `matchRoutePattern` bails at the first segment that has no counterpart, so
  // probing with "/" never reaches a later `**` — `/admin/**/secret` would
  // slip through and either throw lazily (depending on which routes exist) or,
  // worse, match nothing at all and silently publish the URLs the pattern was
  // written to hide.
  for (const pattern of patterns) {
    // An empty entry — from a filtered array or a split env var — would match
    // "/" and quietly drop the homepage.
    if (pattern === "") {
      throw new Error(
        'Invalid llmsTxt.exclude pattern: empty string. Remove it, or use "/" to exclude the homepage.',
      );
    }
    // `defineApp({ constraints })` patterns are absolute; accepting a relative
    // one here would contradict "the same segment globs".
    if (!pattern.startsWith("/") && pattern !== "**") {
      throw new Error(
        `Invalid llmsTxt.exclude pattern ${JSON.stringify(pattern)}: patterns are absolute and must ` +
          'start with "/" (or be "**" to match everything).',
      );
    }

    const segments = pattern.split("/").filter(Boolean);
    const wildcardIndex = segments.indexOf("**");
    if (wildcardIndex !== -1 && wildcardIndex !== segments.length - 1) {
      throw new Error(
        `Invalid llmsTxt.exclude pattern ${JSON.stringify(pattern)}: ` +
          '"**" is only supported as the final segment. Patterns use the same segment globs as ' +
          'defineApp({ constraints }) — "*" matches exactly one segment and a trailing "**" ' +
          "matches the rest.",
      );
    }
  }

  return (path) => patterns.some((pattern) => matchRoutePattern(pattern, path));
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
    const markdown =
      typeof routeModule?.markdown === "string" || typeof routeModule?.markdown === "function";

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

// Only HTTP-exposed capabilities are listed — private ones have no URL an
// agent could call, and webmcp exposure requires expose.http anyway. Invalid
// capability registrations propagate as errors, matching HTTP dispatch and
// `pracht inspect` rather than silently emitting an incomplete file.
async function collectCapabilityEntries(
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
