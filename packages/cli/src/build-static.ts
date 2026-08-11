import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildStaticRouteStateUrl,
  resolveAppCapabilities,
  type ModuleRegistry,
  type PrerenderResult,
  type ResolvedApiRoute,
  type ResolvedPrachtApp,
  type ResolvedRoute,
  type RouteSegment,
} from "@pracht/core/server";

import {
  escapeRegex,
  PRACHT_BASELINE_SECURITY_HEADERS,
  publishableDocumentHeaders,
  routeToRouteExpression,
  routeToStaticHtmlPath,
  sortStaticRoutes,
} from "./build-shared.js";
import { VERSION } from "./constants.js";

export type StaticHost = "netlify" | "vercel" | "generic";

const STATIC_HOSTS = new Set<string>(["netlify", "vercel", "generic"]);

/** Where a dynamic SPA route's single fallback document is written. */
const SPA_FALLBACK_DIR = "/_pracht/spa";
const NOT_FOUND_FILE = "/404.html";
/** Hashed build assets are content-addressed, so they never need revalidating. */
const IMMUTABLE_ASSET_SOURCE = "/assets/*";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface StaticRewriteRule {
  /** The route pattern this rule answers, in pracht syntax. */
  pattern: string;
  /** Anchored regular expression matching request paths for the pattern. */
  regex: string;
  /** Document served for a match, as a path under `dist/client`. */
  destination: string;
}

export interface StaticHeaderRule {
  /** Request path, or a `*`-suffixed prefix. */
  source: string;
  headers: Record<string, string>;
}

/**
 * The routing and header rules a static host has to apply. Written to
 * `dist/server/static-manifest.json` (never to the published directory) so
 * `pracht preview` can serve the build the way the host will, and so an
 * unsupported host has something machine-readable to translate.
 */
export interface StaticBuildManifest {
  host: StaticHost;
  rewrites: StaticRewriteRule[];
  headers: StaticHeaderRule[];
  /** Document served for unmatched paths, or null when the app has no `notFound`. */
  notFound: string | null;
}

export function normalizeStaticHost(value: unknown): StaticHost {
  return typeof value === "string" && STATIC_HOSTS.has(value) ? (value as StaticHost) : "generic";
}

/**
 * Reject apps the static target cannot serve, before the build spends time
 * prerendering output that would 404 in production. Every problem is reported
 * at once: fixing them one build at a time is miserable.
 */
export function assertStaticBuildSupported(
  app: Pick<ResolvedPrachtApp, "agents" | "routes">,
  apiRoutes: readonly ResolvedApiRoute[] = [],
): void {
  const problems: string[] = [];

  for (const route of app.routes) {
    const render = route.render ?? "ssr";
    if (render === "ssr") {
      problems.push(
        `  ${route.path} — render: "ssr" needs a server on every request. Use "ssg" (prerendered), ` +
          `or "spa" when the page fetches its own data in the browser.`,
      );
      continue;
    }
    if (render === "isg") {
      problems.push(
        `  ${route.path} — render: "isg" needs a runtime to revalidate. Use "ssg" and rebuild when ` +
          "the content changes.",
      );
      continue;
    }
    if (render === "spa" && hasDynamicSegments(route)) {
      // One document answers every URL under the pattern, so there is no path
      // to key a build-time route-state snapshot by.
      if (route.hasLoader !== false) {
        problems.push(
          `  ${route.path} — a dynamic SPA route is served by one fallback document, so its loader ` +
            'cannot run per URL. Fetch the data from the component instead, or make the route "ssg" ' +
            "with getStaticPaths().",
        );
      }
      if (route.middlewareFiles.length > 0) {
        problems.push(
          `  ${route.path} — a dynamic SPA route is served by one fallback document, so its ` +
            `middleware (${route.middleware.join(", ")}) cannot run per URL. Move the check into the ` +
            'page, or make the route "ssg" with getStaticPaths().',
        );
      }
    }
  }

  if (apiRoutes.length > 0) {
    const names = apiRoutes.map((route) => route.path).sort();
    problems.push(
      `  ${names.join(", ")} — API routes need a server. Call an external endpoint from the ` +
        "browser, or deploy with an adapter that has a runtime.",
    );
  }

  if (app.agents && Object.keys(app.agents).length > 0) {
    problems.push(
      "  defineApp({ agents }) — Web Bot Auth, confirmation, and remote MCP are request-time " +
        "policies. Remove the agent runtime config or deploy with an adapter that has a server.",
    );
  }

  if (problems.length === 0) return;

  throw new Error(
    [
      `The static target cannot build this app — ${problems.length} problem${problems.length === 1 ? "" : "s"} need a server runtime:`,
      "",
      ...problems,
      "",
      "Switch to @pracht/adapter-node, @pracht/adapter-cloudflare, or @pracht/adapter-vercel to keep them.",
    ].join("\n"),
  );
}

/** Reject capability HTTP projections while preserving private build-time use. */
export async function assertStaticCapabilitiesSupported(
  app: Pick<ResolvedPrachtApp, "agents" | "capabilities" | "middleware">,
  registry: ModuleRegistry,
): Promise<void> {
  const exposed = (await resolveAppCapabilities(app, registry))
    .filter((capability) => capability.httpPath !== null)
    .map((capability) => capability.name)
    .sort();
  if (exposed.length === 0) return;

  throw new Error(
    `The static target cannot serve HTTP-exposed capabilities (${exposed.join(", ")}). ` +
      "Keep them private for build-time invokeCapability() calls, or deploy with an adapter " +
      "that has a server runtime.",
  );
}

export interface WriteStaticBuildOutputOptions {
  root: string;
  clientDir: string;
  host: StaticHost;
  pages: PrerenderResult[];
  notFound?: PrerenderResult;
  headersManifest: Record<string, Record<string, string>>;
}

export interface StaticBuildOutput {
  /** Directory to deploy, relative to the project root. */
  outputPath: string;
  manifest: StaticBuildManifest;
  routeStateCount: number;
  spaFallbacks: StaticRewriteRule[];
}

export function writeStaticBuildOutput({
  root,
  clientDir,
  host,
  pages,
  notFound,
  headersManifest,
}: WriteStaticBuildOutputOptions): StaticBuildOutput {
  // Do not leave a deployable but stale Vercel artifact behind after changing
  // the selected host. Preserve `.vercel/project.json`; only generated output
  // belongs to this build.
  if (host !== "vercel") {
    rmSync(resolve(root, ".vercel/output"), { force: true, recursive: true });
  }

  const routeStateCount = writeRouteStateSnapshots(clientDir, pages);
  const spaFallbacks = writeSpaFallbackDocuments(clientDir, pages);

  if (notFound) {
    writeStaticFile(clientDir, NOT_FOUND_FILE, notFound.html);
  }

  const staticRoutes = pages
    .filter((page) => page.fallbackFor === undefined)
    .map((page) => page.path);
  const manifest: StaticBuildManifest = {
    host,
    rewrites: spaFallbacks,
    headers: createHeaderRules(staticRoutes, headersManifest, notFound),
    notFound: notFound ? NOT_FOUND_FILE : null,
  };

  mkdirSync(resolve(root, "dist/server"), { recursive: true });
  writeFileSync(
    resolve(root, "dist/server/static-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  let outputPath = relative(root, clientDir) || "dist/client";
  if (host === "netlify") {
    writeNetlifyConfig(clientDir, manifest);
  } else if (host === "vercel") {
    outputPath = writeStaticVercelOutput({ root, clientDir, manifest, staticRoutes });
  }

  return { outputPath, manifest, routeStateCount, spaFallbacks };
}

/**
 * Write the loader results a client navigation would otherwise fetch from the
 * route-state endpoint. `/blog/hello` is answered from
 * `/_pracht/state/blog/hello/index.json` — the same URL the client router
 * derives. Keeping one directory per route prevents `/` and `/index` from
 * colliding.
 */
function writeRouteStateSnapshots(clientDir: string, pages: PrerenderResult[]): number {
  let count = 0;
  for (const page of pages) {
    if (page.routeState === undefined) continue;
    writeStaticFile(clientDir, buildStaticRouteStateUrl(page.path), page.routeState);
    count += 1;
  }
  return count;
}

/**
 * A dynamic SPA route renders in the browser, so one document answers every
 * URL under its pattern. It cannot live at a path (there isn't one), so it is
 * written to a reserved directory and reached through a host rewrite.
 */
function writeSpaFallbackDocuments(
  clientDir: string,
  pages: PrerenderResult[],
): StaticRewriteRule[] {
  const rules: StaticRewriteRule[] = [];
  const used = new Set<string>();

  for (const page of pages) {
    if (page.fallbackFor === undefined) continue;

    let slug = patternToSlug(page.fallbackFor);
    while (used.has(slug)) slug = `${slug}-1`;
    used.add(slug);

    const destination = `${SPA_FALLBACK_DIR}/${slug}.html`;
    writeStaticFile(clientDir, destination, page.html);

    // Header rules are keyed by request path, and this document answers a
    // whole pattern rather than one path — there is nothing to key them by.
    const unappliedHeaders = Object.keys(staticDocumentHeaders(page.headers));
    if (unappliedHeaders.length > 0) {
      console.warn(
        `  Warning: the headers() export on "${page.fallbackFor}" (${unappliedHeaders.join(", ")}) ` +
          "is not applied. Its document answers every URL under the pattern, so the host has no " +
          "path to attach the headers to; configure them on your host directly.",
      );
    }
    rules.push({
      pattern: page.fallbackFor,
      regex: patternToRegexSource(page.fallbackFor),
      destination,
    });
  }

  // Longest pattern first: `/app/settings` has to win over `/app/:id`.
  return rules.sort((left, right) => right.pattern.length - left.pattern.length);
}

function createHeaderRules(
  staticRoutes: string[],
  headersManifest: Record<string, Record<string, string>>,
  notFound: PrerenderResult | undefined,
): StaticHeaderRule[] {
  const rules: StaticHeaderRule[] = [
    { source: "/*", headers: Object.fromEntries(PRACHT_BASELINE_SECURITY_HEADERS) },
    { source: IMMUTABLE_ASSET_SOURCE, headers: { "cache-control": IMMUTABLE_CACHE_CONTROL } },
  ];

  for (const route of sortStaticRoutes(staticRoutes)) {
    const headers = staticDocumentHeaders(headersManifest[route]);
    if (Object.keys(headers).length === 0) continue;
    rules.push({ source: route, headers });
  }

  if (notFound) {
    const headers = staticDocumentHeaders(notFound.headers);
    if (Object.keys(headers).length > 0) rules.push({ source: NOT_FOUND_FILE, headers });
  }

  return rules;
}

/** A static URL has one representation and no route-state endpoint to vary on. */
function staticDocumentHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return publishableDocumentHeaders(headers, {
    dropAcceptVary: true,
    dropRouteStateVary: true,
  });
}

function writeNetlifyConfig(clientDir: string, manifest: StaticBuildManifest): void {
  const headerLines: string[] = [];
  for (const rule of manifest.headers) {
    headerLines.push(rule.source);
    for (const [key, value] of Object.entries(rule.headers)) {
      headerLines.push(`  ${key}: ${value}`);
    }
    headerLines.push("");
  }
  writeFileSync(join(clientDir, "_headers"), headerLines.join("\n"), "utf-8");

  // Netlify serves `about/index.html` for `/about` and `404.html` for
  // unmatched paths on its own, so the only rules it needs are the SPA
  // fallbacks. Writing an explicit `/* /404.html 404` rule would shadow them.
  if (manifest.rewrites.length === 0) {
    rmSync(join(clientDir, "_redirects"), { force: true });
    return;
  }

  const redirectLines = manifest.rewrites.map(
    (rule) => `${patternToNetlifyPattern(rule.pattern)}  ${rule.destination}  200`,
  );
  writeFileSync(join(clientDir, "_redirects"), `${redirectLines.join("\n")}\n`, "utf-8");
}

/**
 * Emit a Build Output API v3 directory with no functions in it. Vercel serves
 * it entirely from its CDN — the same deployment path the other adapters use,
 * without a single invocation.
 */
function writeStaticVercelOutput({
  root,
  clientDir,
  manifest,
  staticRoutes,
}: {
  root: string;
  clientDir: string;
  manifest: StaticBuildManifest;
  staticRoutes: string[];
}): string {
  const outputDir = join(root, ".vercel/output");
  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(clientDir, join(outputDir, "static"), { recursive: true });

  const routes: Record<string, unknown>[] = [];
  // Headers are route entries, not a top-level key: the Build Output API only
  // applies `headers` when they hang off a matched route, and `continue: true`
  // keeps the request flowing to the rewrite that actually serves it.
  for (const rule of manifest.headers) {
    routes.push({
      src: headerSourceToVercelSrc(rule.source),
      headers: rule.headers,
      continue: true,
    });
  }
  for (const route of sortStaticRoutes(staticRoutes)) {
    routes.push({ src: routeToRouteExpression(route), dest: routeToStaticHtmlPath(route) });
  }
  routes.push({ handle: "filesystem" });
  // SPA fallbacks are matched only once the filesystem has missed, so a real
  // file under the pattern (`/projects/logo.png`) is never shadowed by the
  // route's document. Netlify gets this ordering for free: an unforced
  // `_redirects` rule already yields to an existing file.
  for (const rule of manifest.rewrites) {
    routes.push({ src: rule.regex, dest: rule.destination });
  }
  if (manifest.notFound) {
    routes.push({ handle: "error" });
    routes.push({ src: "/(.*)", status: 404, dest: manifest.notFound });
  }

  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify(
      {
        version: 3,
        framework: { version: VERSION },
        routes,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return ".vercel/output";
}

/** `/*` → `/(.*)`, `/assets/*` → `/assets/(.*)`, `/about` → `^/about/?$`. */
function headerSourceToVercelSrc(source: string): string {
  if (source === "/*") return "/(.*)";
  if (source.endsWith("/*")) return `${escapeRegex(source.slice(0, -2))}/(.*)`;
  return routeToRouteExpression(source);
}

function hasDynamicSegments(route: ResolvedRoute): boolean {
  return route.segments.some((segment) => segment.type === "param" || segment.type === "catchall");
}

/** `/app/:id` → `app-id`, `/docs/:rest*` → `docs-rest`, `/` → `index`. */
function patternToSlug(pattern: string): string {
  const slug = pattern
    .replace(/[^a-zA-Z0-9/]+/g, "")
    .split("/")
    .filter(Boolean)
    .join("-");
  return slug || "index";
}

/** Netlify placeholders: `:name` for a param, `*` for a catch-all tail. */
function patternToNetlifyPattern(pattern: string): string {
  const parts = segmentsOf(pattern).map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return `:${segment.name}`;
    return "*";
  });
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function patternToRegexSource(pattern: string): string {
  const parts = segmentsOf(pattern).map((segment) => {
    if (segment.type === "static") return escapeRegex(segment.value);
    if (segment.type === "param") return "[^/]+";
    return ".+";
  });
  return parts.length === 0 ? "^/$" : `^/${parts.join("/")}/?$`;
}

function segmentsOf(pattern: string): RouteSegment[] {
  return pattern
    .split("/")
    .filter(Boolean)
    .map((segment): RouteSegment => {
      if (segment === "*") return { type: "catchall", name: "*" };
      if (segment.startsWith(":") && segment.endsWith("*")) {
        return { type: "catchall", name: segment.slice(1, -1) || "*" };
      }
      if (segment.startsWith(":")) return { type: "param", name: segment.slice(1) };
      return { type: "static", value: segment };
    });
}

/**
 * Resolve a URL path to a file inside the published directory, refusing
 * anything that would escape it. Route params reach these paths, so the guard
 * is load-bearing rather than defensive.
 */
export function resolveStaticOutputPath(clientDir: string, urlPath: string): string {
  if (urlPath.includes("\0")) {
    throw new Error(`Refusing to write static output for "${urlPath}" with a NUL byte.`);
  }

  const rootDir = resolve(clientDir);
  const filePath = resolve(rootDir, `.${urlPath}`);
  const relativePath = relative(rootDir, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to write static output for "${urlPath}" outside ${clientDir}.`);
  }

  return filePath;
}

function writeStaticFile(clientDir: string, urlPath: string, contents: string): void {
  const filePath = resolveStaticOutputPath(clientDir, urlPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf-8");
}
