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
  MaybePromise,
  ModuleRegistry,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteModule,
  RouteParams,
} from "./types.ts";

export type LlmsTxtSection = "pages" | "api" | "capabilities";

export interface LlmsTxtPageContext {
  /** Concrete URL path, after expanding dynamic SSG/ISG routes. */
  path: string;
  /** The loaded route-module namespace, including custom plugin exports. */
  data: RouteModule & Record<string, any>;
}

export interface LlmsTxtPageMetadata {
  /** Link label. Defaults to the concrete route path. */
  title?: string;
  /** Text rendered after the link. */
  description?: string;
  /** H2 heading for this page. Defaults to "Pages". */
  section?: string;
}

export interface LlmsTxtArtifact {
  /** Path relative to the static output directory. */
  outputPath: string;
  content: string;
}

declare const __PRACHT_AGENT_SURFACE__: boolean | undefined;

export interface BuildLlmsTxtOptions {
  app: ResolvedPrachtApp;
  apiRoutes?: readonly ResolvedApiRoute[];
  registry?: ModuleRegistry;
  /** H1 project title — the only required llms.txt element. */
  title: string;
  /** Blockquote summary rendered under the title. Omitted when empty. */
  description?: string;
  /** Curated Markdown inserted after the summary and before the sections. */
  details?: string | readonly string[];
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
   * Map a concrete page and its route-module exports to llms.txt metadata.
   * Return `false` to omit the page. Custom content formats stay in userland.
   */
  page?: (
    context: LlmsTxtPageContext,
  ) => MaybePromise<LlmsTxtPageMetadata | false | null | undefined>;
  /**
   * Render a page's Markdown source for `.md` assets and llms-full.txt.
   * Defaults to the route module's `markdown` string export.
   */
  render?: (context: LlmsTxtPageContext) => MaybePromise<string | null | undefined>;
  /** Emit llms-full.txt containing every rendered page source. */
  full?: boolean;
  /** Link rendered pages to generated `.md` assets instead of their HTML URL. */
  markdownSuffix?: boolean;
}

interface LlmsTxtPageEntry {
  path: string;
  title: string;
  description?: string;
  section: string;
  source?: string;
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
  const artifacts = await buildLlmsTxtArtifacts(options);
  return artifacts[0].content;
}

/** Build llms.txt plus optional llms-full.txt and per-page Markdown assets. */
export async function buildLlmsTxtArtifacts(
  options: BuildLlmsTxtOptions,
): Promise<LlmsTxtArtifact[]> {
  const include = options.include ?? ["pages", "api", "capabilities"];
  const origin = options.origin?.replace(/\/$/, "") ?? "";
  const excludesPattern = createExcludeMatcher(options.exclude);
  const isExcluded = (path: string): boolean => isReservedPath(path) || excludesPattern(path);

  const lines: string[] = [`# ${options.title}`];
  if (options.description) {
    lines.push("", `> ${options.description}`);
  }

  const details = typeof options.details === "string" ? [options.details] : (options.details ?? []);
  for (const detail of details) {
    if (detail) lines.push("", detail);
  }

  let pages: LlmsTxtPageEntry[] = [];

  if (include.includes("pages")) {
    pages = await collectPageEntries(
      options.app.routes,
      options.registry,
      options.page,
      options.render,
      isExcluded,
    );
    if (pages.length > 0) {
      const sections = new Map<string, LlmsTxtPageEntry[]>();
      for (const page of pages) {
        const entries = sections.get(page.section) ?? [];
        entries.push(page);
        sections.set(page.section, entries);
      }
      for (const [section, entries] of sections) {
        lines.push("", `## ${section}`, "");
        for (const page of entries) {
          const href =
            options.markdownSuffix && page.source !== undefined
              ? markdownSuffixPath(page.path)
              : page.path;
          const notes = [
            ...(page.description ? [page.description] : []),
            ...(page.markdown ? ["supports `Accept: text/markdown`"] : []),
          ];
          const note = notes.length > 0 ? `: ${notes.join(" — ")}` : "";
          lines.push(`- [${page.title}](${origin}${href})${note}`);
        }
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

  const artifacts: LlmsTxtArtifact[] = [
    { outputPath: "llms.txt", content: `${lines.join("\n")}\n` },
  ];

  if (options.full) {
    const fullLines = [`# ${options.title}`];
    if (options.description) fullLines.push("", `> ${options.description}`);
    for (const detail of details) {
      if (detail) fullLines.push("", detail);
    }
    for (const page of pages) {
      if (page.source === undefined) continue;
      fullLines.push("", "---", "", `# ${page.title}`);
      if (page.description) fullLines.push("", `> ${page.description}`);
      if (page.source.trim()) fullLines.push("", page.source.trim());
    }
    artifacts.push({ outputPath: "llms-full.txt", content: `${fullLines.join("\n")}\n` });
  }

  if (options.markdownSuffix) {
    for (const page of pages) {
      if (page.source === undefined) continue;
      artifacts.push({
        outputPath: markdownSuffixPath(page.path).slice(1),
        content: `${page.source.replace(/\n*$/, "")}\n`,
      });
    }
  }

  return artifacts;
}

function markdownSuffixPath(path: string): string {
  if (path === "/") return "/index.md";
  if (path === "/index") return "/index/index.md";
  if (path.endsWith("/")) return `${path}index.md`;
  return `${path}.md`;
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
  pageMapper: BuildLlmsTxtOptions["page"],
  sourceRenderer: BuildLlmsTxtOptions["render"],
  isExcluded: (path: string) => boolean,
): Promise<LlmsTxtPageEntry[]> {
  const entries = new Map<string, LlmsTxtPageEntry>();

  for (const route of routes) {
    const routeModule = await loadRouteModule(registry, route.file);
    const data = (routeModule ?? {}) as RouteModule & Record<string, any>;
    const markdown = typeof routeModule?.markdown === "string";

    const createEntry = async (path: string): Promise<LlmsTxtPageEntry | undefined> => {
      if (isExcluded(path)) return undefined;
      const context = { data, path };
      const metadata = (await pageMapper?.(context)) ?? {};
      if (metadata === false) return undefined;
      if (typeof metadata !== "object") {
        throw new Error(`llmsTxt.page() returned invalid metadata for ${JSON.stringify(path)}.`);
      }
      const rendered = sourceRenderer
        ? await sourceRenderer(context)
        : typeof routeModule?.markdown === "string"
          ? routeModule.markdown
          : undefined;
      if (rendered !== undefined && rendered !== null && typeof rendered !== "string") {
        throw new Error(`llmsTxt.render() must return a string for ${JSON.stringify(path)}.`);
      }
      return {
        description: metadata.description,
        markdown,
        path,
        section: metadata.section || "Pages",
        source: rendered ?? undefined,
        title: metadata.title || path,
      };
    };

    if (!isDynamicRoute(route)) {
      if (!entries.has(route.path)) {
        const entry = await createEntry(route.path);
        if (entry) entries.set(route.path, entry);
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
        const entry = await createEntry(path);
        if (entry) entries.set(path, entry);
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
