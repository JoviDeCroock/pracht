/**
 * Which prerendered pages also get a `<path>.md` file (`/about` → `/about.md`,
 * the root at `/index.md`).
 *
 * A page gets one only when the file is exactly what its own URL answers to
 * `Accept: text/markdown`, for every visitor: an SSG route with a static
 * string `markdown` export and no middleware anywhere in its chain. The file
 * is that export, verbatim — the same body the runtime sends. A route whose
 * Markdown is decided per request (`markdown: true`, any middleware, ISG) keeps
 * negotiation and gets no file.
 *
 * Build- and dev-only: `pracht build` and the dev server call this; the request
 * runtime never imports it, so a server bundle pays nothing for it.
 */

import { matchAppRoute } from "./app.ts";
import { buildPathFromSegments, markdownFilePath, normalizeRoutePath } from "./route-matching.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  ModuleRegistry,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteModule,
  RouteSegment,
} from "./types.ts";

export { markdownFilePath };

export interface MarkdownFile {
  /** The page the file belongs to (`/about`). */
  pagePath: string;
  /** Base-free URL path of the file (`/about.md`). */
  markdownPath: string;
  /** The file's contents: the route's `markdown` export, verbatim. */
  source: string;
}

export interface MarkdownFilePlan {
  files: MarkdownFile[];
  /** Markdown-capable pages that get no file, with the reason. */
  skipped: { pagePath: string; reason: string }[];
}

export interface PlanMarkdownFilesOptions {
  app: ResolvedPrachtApp;
  apiRoutes?: readonly ResolvedApiRoute[];
  registry?: ModuleRegistry;
  /**
   * Every prerendered page path. Defaults to the SSG/ISG routes' own paths
   * (static paths and `getStaticPaths()` instances), which is what the dev
   * server uses.
   */
  pages?: readonly string[];
  /** Whether a file or directory already sits at a Markdown path in the output. */
  fileExists?: (markdownPath: string) => boolean;
  /**
   * Called when a route's module or `getStaticPaths()` fails while the page
   * list is being derived (only when `pages` is omitted). The route is then
   * left out of the plan instead of failing it; without this the error throws.
   */
  onRouteError?: (route: ResolvedRoute, error: unknown) => void;
}

/**
 * Decide which pages get a Markdown file. A file never takes a URL something
 * else answers: a page, an exact page or API route, a path a route or page
 * nests below (`/about.md/...`), another page's file (`/` and `/index` both
 * map to `/index.md`; the root wins), or a file already in the output.
 * Collisions compare decoded, case-folded paths, as a portable filesystem does.
 */
export async function planMarkdownFiles(
  options: PlanMarkdownFilesOptions,
): Promise<MarkdownFilePlan> {
  const { app, registry } = options;
  const pages =
    options.pages ?? (await collectPrerenderedPaths(app, registry, options.onRouteError));

  const exactOwners = new Map<string, string>();
  const parentOwners = new Map<string, string>();
  const addOwner = (path: string, owner: string, hasChildren: boolean) => {
    const key = portableKey(path);
    if (!hasChildren && !exactOwners.has(key)) exactOwners.set(key, owner);
    // Every proper ancestor (and, for a dynamic route, its static prefix
    // itself) has to stay a directory.
    const segments = key.split("/").filter(Boolean);
    for (let end = hasChildren ? segments.length : segments.length - 1; end > 0; end -= 1) {
      const ancestor = `/${segments.slice(0, end).join("/")}`;
      if (!parentOwners.has(ancestor)) parentOwners.set(ancestor, owner);
    }
  };
  const addRouteOwner = (route: { path: string; segments: RouteSegment[] }, owner: string) => {
    const dynamicAt = route.segments.findIndex((s) => s.type !== "static");
    if (dynamicAt === -1) {
      addOwner(route.path, owner, false);
    } else if (dynamicAt > 0) {
      const prefix = route.segments
        .slice(0, dynamicAt)
        .map((segment) => (segment.type === "static" ? segment.value : ""));
      addOwner(`/${prefix.join("/")}`, owner, true);
    }
  };
  for (const route of app.routes) addRouteOwner(route, `the page route "${route.path}"`);
  for (const route of options.apiRoutes ?? []) {
    addRouteOwner(route, `the API route "${route.path}"`);
  }
  for (const page of pages) addOwner(page, `the page "${page}"`, false);

  const files: MarkdownFile[] = [];
  const skipped: MarkdownFilePlan["skipped"] = [];
  const claimed = new Set<string>();
  const modules = new Map<string, Promise<RouteModule | undefined>>();
  // The root claims `/index.md` ahead of a literal `/index` page.
  const ordered = [...pages].sort((left, right) => Number(right === "/") - Number(left === "/"));
  for (const pagePath of ordered) {
    // First match, exactly as the runtime resolves the page's own URL.
    const route = matchAppRoute(app, pagePath)?.route;
    if (!route) continue;
    let routeModule = modules.get(route.file);
    if (!routeModule) {
      routeModule = resolveRegistryModule<RouteModule>(registry?.routeModules, route.file);
      modules.set(route.file, routeModule);
    }
    let markdown: unknown;
    try {
      markdown = (await routeModule)?.markdown;
    } catch (error) {
      if (!options.onRouteError) throw error;
      options.onRouteError(route, error);
      continue;
    }
    const source = typeof markdown === "string" ? markdown : undefined;
    if (source === undefined && route.markdown !== true) continue;

    const reason = ineligibleReason(route, source);
    if (reason !== undefined || source === undefined) {
      skipped.push({ pagePath, reason: reason ?? "no `markdown` export" });
      continue;
    }

    const markdownPath = markdownFilePath(pagePath);
    const key = portableKey(markdownPath);
    const owner = exactOwners.get(key) ?? parentOwners.get(key);
    if (owner !== undefined) {
      skipped.push({ pagePath, reason: `${markdownPath} is taken by ${owner}` });
    } else if (claimed.has(key)) {
      skipped.push({ pagePath, reason: `${markdownPath} is taken by another page's file` });
    } else if (options.fileExists?.(markdownPath)) {
      skipped.push({ pagePath, reason: `${markdownPath} already exists` });
    } else {
      claimed.add(key);
      files.push({ pagePath, markdownPath, source });
    }
  }
  return { files, skipped };
}

function ineligibleReason(route: ResolvedRoute, source: string | undefined): string | undefined {
  if (route.render !== "ssg") return `${String(route.render).toUpperCase()} route`;
  if (route.middleware.length > 0) return "middleware decides";
  if (source === undefined) return "`markdown: true` without a `markdown` export";
  return undefined;
}

/** The concrete paths `pracht build` prerenders for SSG/ISG routes. */
async function collectPrerenderedPaths(
  app: ResolvedPrachtApp,
  registry: ModuleRegistry | undefined,
  onRouteError: PlanMarkdownFilesOptions["onRouteError"],
): Promise<string[]> {
  const paths: string[] = [];
  for (const route of app.routes) {
    if (route.render !== "ssg" && route.render !== "isg") continue;
    if (route.segments.every((segment) => segment.type === "static")) {
      paths.push(route.path);
      continue;
    }
    try {
      const routeModule = await resolveRegistryModule<RouteModule>(
        registry?.routeModules,
        route.file,
      );
      if (typeof routeModule?.getStaticPaths !== "function") continue;
      const params = await routeModule.getStaticPaths();
      paths.push(...params.map((entry) => buildPathFromSegments(route.segments, entry)));
    } catch (error) {
      if (!onRouteError) throw error;
      onRouteError(route, error);
    }
  }
  return paths;
}

/** Decoded, NFC, lower-cased: the identity a portable filesystem gives a path. */
function portableKey(path: string): string {
  return normalizeRoutePath(path)
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {}
      return decoded.normalize("NFC").toLowerCase();
    })
    .join("/");
}
