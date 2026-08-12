import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin } from "vite";
import {
  applyDefaultSecurityHeaders,
  classifyRevalidationSkip,
  createISGRegenerationRequest,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  isCacheableISGResponse,
  isDangerousPrerenderHeader,
  jsonResponse,
  matchAppRoute,
  prefersMarkdown,
  preventHeuristicCaching,
  PRACHT_REVALIDATE_ENDPOINT,
  readRevalidationRequest,
  RevalidationReport,
  resolveRevalidationToken,
  routeSupportsMarkdown,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  type MarkdownManifest,
  type ModuleRegistry,
  type PrachtApp,
  type ResolvedApiRoute,
  type ResolvedRoute,
} from "@pracht/core/server";

export type HeadersManifest = Record<string, Record<string, string>>;

export interface NetlifyExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  [key: string]: unknown;
}

export interface NetlifyContextArgs<
  TNetlifyContext extends NetlifyExecutionContext = NetlifyExecutionContext,
> {
  request: Request;
  context: TNetlifyContext;
}

export interface NetlifyPurgeCacheOptions {
  tags?: string[];
}

export type NetlifyPurgeCache = (options?: NetlifyPurgeCacheOptions) => Promise<unknown>;

/** Purge Netlify's cache without making applications depend on the platform SDK directly. */
export async function purgeNetlifyCache(options?: NetlifyPurgeCacheOptions): Promise<void> {
  const { purgeCache } = await import("@netlify/functions");
  await purgeCache(options);
}

export interface NetlifyCacheOptions {
  /** Seconds stale ISG output may be served while Netlify refreshes it. Defaults to one year. */
  staleWhileRevalidate?: number;
  /** Edge lifetime for immutable-per-deploy SSG documents. Defaults to one year. */
  staticMaxAge?: number;
}

export interface NetlifyHandlerOptions<
  TNetlifyContext extends NetlifyExecutionContext = NetlifyExecutionContext,
  TContext = TNetlifyContext,
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  staticDir?: string;
  isgManifest?: Record<string, ISGManifestEntry>;
  headersManifest?: HeadersManifest;
  /** Exact Markdown-capable routes. Omit only for legacy/custom server entries. */
  markdownManifest?: MarkdownManifest;
  createContext?: (args: NetlifyContextArgs<TNetlifyContext>) => TContext | Promise<TContext>;
  purgeCache?: NetlifyPurgeCache;
  cache?: NetlifyCacheOptions;
}

export interface NetlifyAdapterOptions extends NetlifyCacheOptions {
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
  /** Generated Netlify Function name. Defaults to `pracht`. */
  functionName?: string;
  /** Directory where the generated function wrapper is written. */
  functionsDir?: string;
  /** Additional paths Netlify should serve directly instead of invoking the function. */
  excludedPath?: string[];
}

const DEFAULT_STALE_WHILE_REVALIDATE = 31_536_000;
const DEFAULT_STATIC_MAX_AGE = 31_536_000;
const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
const DEFAULT_EXCLUDED_PATHS = ["/assets/*", "/_pracht/*"];
const ISG_CACHE_TAG = "pracht:isg";
const SHARED_CONTEXT_FIELDS = [
  "account",
  "deploy",
  "json",
  "log",
  "params",
  "server",
  "site",
  "waitUntil",
] as const;
const EMPTY_NETLIFY_GEO = Object.freeze({});
const EMPTY_NETLIFY_COOKIES = Object.freeze({
  delete: rejectSharedContextCookieMutation,
  get: () => undefined,
  set: rejectSharedContextCookieMutation,
});
const EXPLICIT_CACHE_POLICY_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "netlify-cdn-cache-control",
  "surrogate-control",
  "vercel-cdn-cache-control",
] as const;

/**
 * Create a fetch-style Netlify Functions v2 handler.
 *
 * The generated function claims page URLs so negotiated Markdown and route
 * state requests reach Pracht, while ordinary SSG documents are read from the
 * bundled client output and cached in Netlify's durable cache.
 */
export function createNetlifyHandler<
  TNetlifyContext extends NetlifyExecutionContext = NetlifyExecutionContext,
  TContext = TNetlifyContext,
>(options: NetlifyHandlerOptions<TNetlifyContext, TContext>) {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const cache = resolveCacheOptions(options.cache);

  return async (request: Request, context: TNetlifyContext): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleNetlifyRevalidation(request, options, isgManifest);
    }

    const routeStateRequest = isRouteStateRequest(request, url);
    const markdownCapable =
      options.markdownManifest === undefined ||
      routeSupportsMarkdown(options.markdownManifest, url.pathname);
    const wantsMarkdown = prefersMarkdown(request.headers.get("accept")) && markdownCapable;
    const staticMethod = request.method === "GET" || request.method === "HEAD";

    if (
      options.staticDir &&
      staticMethod &&
      !routeStateRequest &&
      !wantsMarkdown &&
      !(url.pathname in isgManifest)
    ) {
      const file = await resolveStaticFile(options.staticDir, url.pathname);
      if (file) {
        return serveStaticFile(
          request,
          file,
          headersManifest,
          url.pathname,
          cache.staticMaxAge,
          markdownCapable,
        );
      }
    }

    const isgRoute =
      staticMethod && !routeStateRequest && !wantsMarkdown && url.pathname in isgManifest
        ? matchAppRoute(options.app, url.pathname)?.route
        : undefined;

    // A Netlify CDN response is shared by every visitor. Render ISG documents
    // from a request stripped of cookies, authorization, query, and body so the
    // visitor who triggers a cache miss cannot personalize the stored result.
    const renderRequest = isgRoute ? createISGRegenerationRequest(url.pathname, request) : request;
    const renderContext = isgRoute ? createNetlifyISGContext(context, renderRequest) : context;
    const prachtContext = options.createContext
      ? await options.createContext({ request: renderRequest, context: renderContext })
      : (renderContext as unknown as TContext);

    const response = await handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request: renderRequest,
      context: prachtContext,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    if (isgRoute) {
      return applyNetlifyISGCacheHeaders(response, isgRoute, url.pathname, cache, markdownCapable);
    }

    return applyNetlifyDynamicCacheHeaders(request, response);
  };
}

/** Cache tag for one concrete ISG pathname. */
export function netlifyRouteCacheTag(pathname: string): string {
  return `pracht:path:${encodeURIComponent(normalizePathname(pathname))}`;
}

/** Return the first candidate containing the Pracht client build directory. */
export async function resolveNetlifyStaticDir(
  candidates: Array<string | null | undefined>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = resolve(candidate);
    const info = await lstat(root).catch(() => null);
    if (info?.isDirectory()) return root;
  }
  return undefined;
}

export function createNetlifyServerEntryModule(options: NetlifyAdapterOptions = {}): string {
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";

  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { createNetlifyHandler, purgeNetlifyCache, resolveNetlifyStaticDir } from "@pracht/adapter-netlify";',
    contextImport,
    "",
    "const serverDir = dirname(fileURLToPath(import.meta.url));",
    "function readManifest(name, fallback) {",
    "  for (const file of [",
    '    resolve(process.cwd(), "dist/server", name),',
    "    resolve(serverDir, name),",
    "  ]) {",
    '    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));',
    "  }",
    "  return fallback;",
    "}",
    "const staticDir = await resolveNetlifyStaticDir([",
    "  process.env.PRACHT_STATIC_DIR,",
    '  resolve(process.cwd(), "dist/client"),',
    '  resolve(serverDir, "../client"),',
    "]);",
    'const isgManifest = readManifest("isg-manifest.json", {});',
    'const headersManifest = readManifest("headers-manifest.json", {});',
    'const markdownManifest = readManifest("markdown-manifest.json", undefined);',
    "",
    "const handler = createNetlifyHandler({",
    "  app: resolvedApp,",
    "  registry,",
    "  apiRoutes,",
    "  clientEntryUrl: clientEntryUrl ?? undefined,",
    "  islandsEntryUrl: islandsEntryUrl ?? undefined,",
    "  islandsBootstrapRequired,",
    "  cssManifest,",
    "  jsManifest,",
    "  staticDir,",
    "  isgManifest,",
    "  headersManifest,",
    "  markdownManifest,",
    "  createContext: createPrachtContext,",
    "  purgeCache: purgeNetlifyCache,",
    `  cache: ${JSON.stringify({
      staleWhileRevalidate: options.staleWhileRevalidate,
      staticMaxAge: options.staticMaxAge,
    })},`,
    "});",
    "",
    "export default function handle(request, context) {",
    "  return handler(request, context);",
    "}",
    "",
  ].join("\n");
}

/**
 * Create a Pracht adapter for Netlify Functions v2.
 *
 * The adapter emits `netlify/functions/pracht.mjs`, which re-exports the
 * bundled Pracht server and declares a catch-all path with static asset
 * exclusions. Set Netlify's publish directory to `dist/client`.
 */
export function netlifyAdapter(options: NetlifyAdapterOptions = {}): PrachtAdapter {
  for (const pattern of options.excludedPath ?? []) assertSafeExcludedPath(pattern);
  return {
    id: "netlify",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createNetlifyServerEntryModule(options);
    },
    vitePlugins() {
      return [netlifyFunctionPlugin(options)];
    },
  };
}

function netlifyFunctionPlugin(options: NetlifyAdapterOptions): Plugin {
  const functionName = options.functionName ?? "pracht";
  const functionsDir = options.functionsDir ?? "netlify/functions";
  const excludedPath = [...DEFAULT_EXCLUDED_PATHS, ...(options.excludedPath ?? [])];
  let root = process.cwd();
  let isSsrBuild = false;

  return {
    name: "pracht:adapter-netlify-function",
    apply: "build",
    configResolved(config) {
      root = config.root;
      isSsrBuild = Boolean(config.build.ssr);
    },
    async closeBundle() {
      if (!isSsrBuild) return;
      const { existsSync } = await import("node:fs");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join, relative } = await import("node:path");
      const dir = join(root, functionsDir);
      const wrapper = join(dir, `${functionName}.mjs`);
      const serverEntry = relative(dir, join(root, "dist/server/server.js")).replaceAll("\\", "/");
      const importPath = serverEntry.startsWith(".") ? serverEntry : `./${serverEntry}`;
      const source = [
        "// Generated by @pracht/adapter-netlify — do not edit.",
        `import handler from ${JSON.stringify(importPath)};`,
        "",
        "export default handler;",
        "",
        `export const config = ${JSON.stringify(
          {
            excludedPath,
            includedFiles: ["dist/client/**", "dist/server/*-manifest.json"],
            name: functionName,
            nodeBundler: "esbuild",
            path: "/*",
          },
          null,
          2,
        )};`,
        "",
      ].join("\n");

      await mkdir(dir, { recursive: true });
      await writeFile(wrapper, source, "utf-8");

      // `excludedPath` URLs bypass the function, so Netlify's static layer
      // serves them without the immutable asset policy and default security
      // headers every other pracht adapter applies to static files. `_headers`
      // in the publish directory is Netlify's mechanism for exactly that. It
      // only affects statically served paths — function responses already
      // carry these headers — so scoping the rules to the excluded prefixes
      // keeps one source of truth per response path.
      if (existsSync(join(root, "public/_headers"))) {
        console.warn(
          "public/_headers exists, so @pracht/adapter-netlify will not generate one. " +
            "Make sure it applies `Cache-Control: public, max-age=31536000, immutable` " +
            "to /assets/* and the default security headers to statically served paths.",
        );
        return;
      }
      const clientDir = join(root, "dist/client");
      await mkdir(clientDir, { recursive: true });
      await writeFile(join(clientDir, "_headers"), createNetlifyHeadersFile(excludedPath), "utf-8");
    },
  };
}

const STATIC_SECURITY_HEADER_LINES = [
  "  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  "  X-Content-Type-Options: nosniff",
  "  X-Frame-Options: SAMEORIGIN",
];

function createNetlifyHeadersFile(excludedPath: string[]): string {
  const lines = [
    "# Generated by @pracht/adapter-netlify — do not edit.",
    "# These paths bypass the pracht function, so Netlify's static layer needs",
    "# the cache and security headers the function applies everywhere else.",
  ];
  for (const pattern of excludedPath) {
    lines.push(pattern);
    if (pattern === "/assets/*") {
      lines.push("  Cache-Control: public, max-age=31536000, immutable");
    }
    lines.push(...STATIC_SECURITY_HEADER_LINES);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `excludedPath` values are written into the plain-text `_headers` file, where
 * a value containing whitespace or a newline could inject arbitrary header
 * rules for other paths. They are also URL path patterns, so anything outside
 * printable-ASCII-without-spaces is a mistake anyway — fail the build loudly.
 */
function assertSafeExcludedPath(pattern: string): void {
  if (!pattern.startsWith("/") || !/^[\x21-\x7e]+$/.test(pattern)) {
    throw new Error(
      `netlifyAdapter({ excludedPath }) entries must be URL path patterns starting with "/" ` +
        `and contain no whitespace or control characters; got ${JSON.stringify(pattern)}.`,
    );
  }
}

async function handleNetlifyRevalidation<TNetlifyContext extends NetlifyExecutionContext, TContext>(
  request: Request,
  options: NetlifyHandlerOptions<TNetlifyContext, TContext>,
  isgManifest: Record<string, ISGManifestEntry>,
): Promise<Response> {
  const parsed = await readRevalidationRequest(request, resolveRevalidationToken());
  if (!parsed.ok) return parsed.response;

  const report = new RevalidationReport();
  for (const pathname of parsed.paths) {
    const entry = isgManifest[pathname];
    const matched = matchAppRoute(options.app, pathname)?.route ?? null;
    const reason = classifyRevalidationSkip(
      entry ? { ...entry, render: "isg" } : undefined,
      Boolean(entry),
      matched,
    );
    if (reason) {
      report.skipped(pathname, reason);
      continue;
    }
    if (!options.purgeCache) {
      report.failed(pathname, "cache_purge_unavailable");
      continue;
    }

    try {
      await options.purgeCache({ tags: [netlifyRouteCacheTag(pathname)] });
      report.revalidated(pathname);
    } catch (error) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, error);
      report.failed(pathname, "cache_purge_failed");
    }
  }

  return jsonResponse(report.toJSON());
}

function applyNetlifyISGCacheHeaders(
  response: Response,
  route: ResolvedRoute,
  pathname: string,
  cache: Required<NetlifyCacheOptions>,
  markdownCapable: boolean,
): Response {
  if (response.status !== 200) return response;

  let prepared = stripDangerousSharedCacheHeaders(response, pathname);
  if (!isCacheableISGResponse(prepared)) return prepared;

  const seconds = getTimeRevalidateSeconds(route.revalidate) ?? cache.staticMaxAge;
  const headers = new Headers(prepared.headers);
  if (!hasExplicitCachePolicy(headers)) {
    headers.set(
      "netlify-cdn-cache-control",
      `public, durable, max-age=${seconds}, stale-while-revalidate=${cache.staleWhileRevalidate}`,
    );
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }
  ensureNetlifyPageVary(headers, markdownCapable);
  appendNetlifyCacheTags(headers, [ISG_CACHE_TAG, netlifyRouteCacheTag(pathname)]);
  prepared = cloneResponse(prepared, headers);
  return prepared;
}

function applyNetlifyDynamicCacheHeaders(request: Request, response: Response): Response {
  const prepared = preventHeuristicCaching(request, response);
  const cacheControl = prepared.headers.get("cache-control");
  if (
    prepared.headers.has("netlify-cdn-cache-control") ||
    !cacheControl ||
    !/(?:^|,)\s*public\b/i.test(cacheControl)
  ) {
    return prepared;
  }

  const headers = new Headers(prepared.headers);
  headers.set("netlify-cdn-cache-control", `${cacheControl}, durable`);
  // The response is now eligible for Netlify's shared cache, and the CDN
  // ignores the standard `Vary` header. Without a `Netlify-Vary` entry, a
  // cached HTML document would also answer route-state fetches (which client
  // navigations send as a request header, not a query param) and — for
  // Markdown-capable routes — `Accept: text/markdown` requests. `query`
  // preserves Netlify's default full-query cache key.
  if (!headers.has("netlify-vary")) {
    const varyValues = (prepared.headers.get("vary") ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim());
    const headerVary = varyValues.includes("accept")
      ? `${ROUTE_STATE_REQUEST_HEADER}|accept`
      : ROUTE_STATE_REQUEST_HEADER;
    headers.set("netlify-vary", `query,header=${headerVary}`);
  }
  return cloneResponse(prepared, headers);
}

function stripDangerousSharedCacheHeaders(response: Response, pathname: string): Response {
  const dangerous = [...response.headers.keys()].filter(isDangerousPrerenderHeader);
  if (dangerous.length === 0) return response;

  const headers = new Headers(response.headers);
  for (const name of dangerous) headers.delete(name);
  console.error(
    `Stripped ${dangerous.map((name) => `"${name}"`).join(", ")} from the ISG response for ` +
      `"${pathname}" before Netlify's shared cache stored it.`,
  );
  return cloneResponse(response, headers);
}

interface StaticFileResult {
  filePath: string;
  contentType: string;
  document: boolean;
}

async function resolveStaticFile(
  staticDir: string,
  pathname: string,
): Promise<StaticFileResult | null> {
  const root = resolve(staticDir);
  const exact = resolveUrlPath(root, pathname);
  if (exact && (await isContainedFile(root, exact))) {
    return {
      contentType: MIME_TYPES[extname(exact)] ?? "application/octet-stream",
      document: exact.endsWith(".html"),
      filePath: exact,
    };
  }

  const index =
    pathname === "/" ? resolve(root, "index.html") : resolveUrlPath(root, pathname, "index.html");
  if (!index || !(await isContainedFile(root, index))) return null;
  return { contentType: "text/html; charset=utf-8", document: true, filePath: index };
}

async function serveStaticFile(
  request: Request,
  file: StaticFileResult,
  headersManifest: HeadersManifest,
  pathname: string,
  staticMaxAge: number,
  markdownCapable: boolean,
): Promise<Response> {
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": file.contentType,
    }),
  );
  if (file.document) applyHeadersManifest(headers, headersManifest, pathname);
  if (!hasExplicitCachePolicy(headers)) {
    headers.set(
      "cache-control",
      pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    );
    headers.set("netlify-cdn-cache-control", `public, durable, max-age=${staticMaxAge}`);
  }
  if (file.document) ensureNetlifyPageVary(headers, markdownCapable);
  const body = request.method === "HEAD" ? null : await readFile(file.filePath);
  return new Response(body, { headers });
}

function hasExplicitCachePolicy(headers: Headers): boolean {
  return EXPLICIT_CACHE_POLICY_HEADERS.some((name) => headers.has(name));
}

/**
 * Netlify's CDN ignores the standard `Vary` header, so a cached page document
 * must name its variants through `Netlify-Vary` or it answers every request
 * for the URL:
 *
 * - `query=_data` — route-state transport via `?_data=1` gets its own cache
 *   key while every unrelated query parameter collapses onto the pathname
 *   entry (sanitized ISG renders never see the query anyway).
 * - `header=x-pracht-route-state-request` — client navigations request route
 *   state with this header on the page URL itself; without it the CDN would
 *   replay cached HTML to a fetch that needs JSON.
 * - `header=…|accept` (Markdown-capable routes only) — `Accept: text/markdown`
 *   must reach the function for negotiation instead of receiving the cached
 *   HTML representation. Scoped to routes that actually export `markdown` so
 *   ordinary pages cannot be fragmented by arbitrary Accept strings.
 *
 * Route-state and Markdown responses themselves are never durable-cached, so
 * the extra variants stay cache misses that reach the function.
 */
function ensureNetlifyPageVary(headers: Headers, markdownCapable: boolean): void {
  if (headers.has("netlify-vary")) return;
  const headerVary = markdownCapable
    ? `${ROUTE_STATE_REQUEST_HEADER}|accept`
    : ROUTE_STATE_REQUEST_HEADER;
  headers.set("netlify-vary", `query=_data,header=${headerVary}`);
}

function appendNetlifyCacheTags(headers: Headers, requiredTags: string[]): void {
  const tags = (headers.get("netlify-cache-tag") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()));
  for (const tag of requiredTags) {
    if (normalized.has(tag.toLowerCase())) continue;
    tags.push(tag);
    normalized.add(tag.toLowerCase());
  }
  headers.set("netlify-cache-tag", tags.join(","));
}

function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const withoutSlash = pathname.replace(/\/$/, "") || "/";
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const values =
    headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex];
  if (!values) return;
  for (const [name, value] of Object.entries(values)) headers.set(name, value);
}

function isRouteStateRequest(request: Request, url: URL): boolean {
  return (
    request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" || url.searchParams.get("_data") === "1"
  );
}

function resolveCacheOptions(
  options: NetlifyCacheOptions | undefined,
): Required<NetlifyCacheOptions> {
  return {
    staleWhileRevalidate: positiveInteger(
      options?.staleWhileRevalidate,
      DEFAULT_STALE_WHILE_REVALIDATE,
    ),
    staticMaxAge: positiveInteger(options?.staticMaxAge, DEFAULT_STATIC_MAX_AGE),
  };
}

function createNetlifyISGContext<TContext extends NetlifyExecutionContext>(
  context: TContext,
  request: Request,
): TContext {
  const shared: NetlifyExecutionContext = Object.create(null);

  for (const field of SHARED_CONTEXT_FIELDS) {
    const value = context[field];
    if (value === undefined) continue;
    shared[field] = typeof value === "function" ? value.bind(context) : value;
  }

  // Netlify exposes these values outside the Request object. Mask them as
  // deliberately as createISGRegenerationRequest() strips visitor headers and
  // query data, or a context factory could still personalize shared output.
  shared.cookies = EMPTY_NETLIFY_COOKIES;
  shared.geo = EMPTY_NETLIFY_GEO;
  shared.ip = "";
  shared.requestId = "";
  shared.url = new URL(request.url);

  return shared as TContext;
}

function rejectSharedContextCookieMutation(): never {
  throw new Error("Netlify cookies cannot be changed while rendering a shared ISG response.");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function normalizePathname(pathname: string): string {
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

function cloneResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function resolveUrlPath(root: string, pathname: string, suffix?: string): string | null {
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const candidate = suffix ? resolve(root, `.${pathname}`, suffix) : resolve(root, `.${pathname}`);
  return pathIsInside(root, candidate) ? candidate : null;
}

async function isContainedFile(root: string, candidate: string): Promise<boolean> {
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const [rootReal, candidateReal] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(candidate).catch(() => null),
  ]);
  return candidateReal !== null && pathIsInside(resolve(rootReal), resolve(candidateReal));
}

function pathIsInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

const MIME_TYPES: Record<string, string> = {
  ".atom": "application/atom+xml",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};
