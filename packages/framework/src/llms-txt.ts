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
import { withBase } from "./base.ts";
import { matchRoutePattern } from "./constraints.ts";
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
  /**
   * Ceiling on how many prerendered instances a single dynamic route
   * contributes to the Pages section. Defaults to
   * {@link DEFAULT_MAX_PAGES_PER_ROUTE}; `0` lists every instance.
   * Must be a non-negative integer.
   *
   * The instances kept are the first ones `getStaticPaths()` returns, after
   * `exclude` is applied — the author's order, which for a blog is usually
   * newest-first. They are listed in path order like every other entry.
   *
   * llms.txt is an index, not a sitemap. A 5,000-post blog expanded through
   * `getStaticPaths()` produces a 5,000-line, 180 KB file — larger than most
   * agent context budgets, and the 4,990th post tells an agent nothing the
   * first ten did not. Truncation is never silent: a line above the Pages
   * section names the route and the ratio it lists.
   */
  maxPagesPerRoute?: number;
}

/**
 * Enough to show the shape of a collection — and of an archive — without the
 * file becoming the collection.
 */
export const DEFAULT_MAX_PAGES_PER_ROUTE = 50;

interface LlmsTxtPageEntry {
  path: string;
  /** True when the route declares a Markdown representation. */
  markdown: boolean;
}

/** One dynamic route whose instances were capped, for the truncation note. */
interface LlmsTxtTruncation {
  routePath: string;
  listed: number;
  omitted: number;
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
  const maxPagesPerRoute = options.maxPagesPerRoute ?? DEFAULT_MAX_PAGES_PER_ROUTE;
  if (!Number.isInteger(maxPagesPerRoute) || maxPagesPerRoute < 0) {
    throw new Error(
      `Invalid llmsTxt.maxPagesPerRoute: expected a non-negative integer (0 lists every page), got ${JSON.stringify(maxPagesPerRoute)}.`,
    );
  }
  // Paths come from the route table, so they carry no deploy base. The links
  // are for crawlers and agents, which need the URL as served.
  const link = (path: string): string => `${origin}${withBase(path)}`;
  const excludesPattern = createExcludeMatcher(options.exclude);
  const isExcluded = (path: string): boolean => isReservedPath(path) || excludesPattern(path);

  const lines: string[] = [`# ${options.title}`];
  if (options.description) {
    lines.push("", `> ${options.description}`);
  }

  if (include.includes("pages")) {
    const collected = await collectPageEntries(options.app.routes, options.registry, {
      isExcluded,
      maxPagesPerRoute,
    });
    if (collected.pages.length > 0) {
      // Truncation notes go in the free-form block above the first H2, not
      // inside `## Pages`. The spec allows "zero or more markdown sections
      // (e.g. paragraphs, lists, etc) of any type except headings" only there;
      // an H2 section is a file list. The reference parser (AnswerDotAI's
      // `llms_txt`, linked from llmstxt.org) feeds every non-blank line inside
      // a section to a link regex and throws on the first line that is not a
      // link — prose or list item alike — so a note inside the section makes
      // the whole file unparseable, a louder failure than the silent
      // truncation it exists to prevent. Above the H2 it still lands in the
      // first thing an agent reads. Several capped routes stay one contiguous
      // block, one line each, so the info block does not become a list.
      if (collected.truncated.length > 0) {
        lines.push("", ...collected.truncated.map(formatTruncationNote));
      }
      lines.push("", "## Pages", "");
      for (const page of collected.pages) {
        const note = page.markdown ? ": supports `Accept: text/markdown`" : "";
        lines.push(`- [${page.path}](${link(page.path)})${note}`);
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
        lines.push(`- [${entry.path}](${link(entry.path)})${note}`);
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
          `- [${entry.name}](${link(entry.path)}): POST (${entry.effect}${confirmation})${description}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The sentence that keeps a capped listing from reading as a complete one.
 *
 * It states the ratio rather than only the remainder because it sits above the
 * section it describes: "N more are not listed" has no antecedent when it is
 * the first line of the file. The verb agrees with the count, so a single
 * omitted page does not read "1 more page ... are not listed".
 */
function formatTruncationNote(truncated: LlmsTxtTruncation): string {
  const one = truncated.omitted === 1;
  return (
    `_Pages lists ${truncated.listed} of ${truncated.listed + truncated.omitted} ` +
    `prerendered URLs under \`${truncated.routePath}\`; ${truncated.omitted} ` +
    `${one ? "is" : "are"} omitted. Raise \`llmsTxt.maxPagesPerRoute\` to ` +
    `include ${one ? "it" : "them"}._`
  );
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
  options: { isExcluded: (path: string) => boolean; maxPagesPerRoute: number },
): Promise<{ pages: LlmsTxtPageEntry[]; truncated: LlmsTxtTruncation[] }> {
  const entries = new Map<string, LlmsTxtPageEntry>();
  const truncated: LlmsTxtTruncation[] = [];

  for (const route of routes) {
    const routeModule = await loadRouteModule(registry, route.file);
    const markdown = hasMarkdownRepresentation(route, routeModule);

    if (!isDynamicRoute(route)) {
      if (!options.isExcluded(route.path) && !entries.has(route.path)) {
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

    // Excluded instances are dropped before the cap is applied: a cap that
    // counted URLs the file was never going to list would silently shrink the
    // listing for anyone using `exclude`. `seen` is a Set rather than a scan of
    // `paths`: an includes() here is O(n^2) in the instance count, which is the
    // one thing a route with 50,000 instances cannot afford.
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const params of paramSets) {
      const path = buildPathFromSegments(route.segments, params);
      if (options.isExcluded(path) || entries.has(path) || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }

    // Truncated in getStaticPaths() order, not sorted order. Sorting first
    // sounds more deterministic but is not — both are deterministic — and it
    // picks the wrong pages: `post-1 … post-5000` sorts to post-1, post-10,
    // post-100, post-1000, post-1001 …, so 43 of the 50 survivors are a
    // consecutive run from the middle of the archive. getStaticPaths() order is
    // the author's, usually newest-first, and prerendering already depends on
    // it. Display order stays lexicographic: `entries` is sorted on the way
    // out, so the file is still byte-stable.
    const limit = options.maxPagesPerRoute > 0 ? options.maxPagesPerRoute : paths.length;
    if (paths.length > limit) {
      truncated.push({ listed: limit, omitted: paths.length - limit, routePath: route.path });
    }
    for (const path of paths.slice(0, limit)) {
      entries.set(path, { markdown, path });
    }
  }

  return {
    pages: [...entries.values()].sort((left, right) => comparePaths(left.path, right.path)),
    truncated,
  };
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
