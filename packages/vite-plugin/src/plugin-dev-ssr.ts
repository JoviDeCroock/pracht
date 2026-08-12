import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Connect, EnvironmentModuleNode, ViteDevServer } from "vite";
import type {
  ModuleRegistry,
  PrachtPhaseTimings,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
} from "@pracht/core";
import { applyDefaultSecurityHeaders, resolveRegistryModule } from "@pracht/core";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  PRACHT_DEV_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
} from "./plugin-assets.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024; // 1 MiB
const CSS_MODULE_URL_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

export const DEVTOOLS_PATH = "/_pracht";
export const DEVTOOLS_JSON_PATH = "/_pracht.json";
export const LLMS_TXT_PATH = "/llms.txt";
export const LLMS_FULL_TXT_PATH = "/llms-full.txt";

/**
 * Serve generated llms.txt artifacts before Vite's publicDir middleware so a
 * public file cannot make development disagree with the production build.
 */
export function createDevLlmsTxtMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  let warnedRouteCollision = false;
  const warnedPublicCollisions = new Set<string>();

  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const requestUrl = new URL(url, "http://localhost");
    if (
      !(
        requestUrl.pathname === LLMS_TXT_PATH ||
        requestUrl.pathname === LLMS_FULL_TXT_PATH ||
        requestUrl.pathname.endsWith(".md")
      ) ||
      !BODYLESS_METHODS.has((req.method ?? "GET").toUpperCase())
    ) {
      return next();
    }

    try {
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);
      if (
        typeof serverMod.generateLlmsTxtArtifacts !== "function" &&
        typeof serverMod.generateLlmsTxt !== "function"
      ) {
        return next();
      }

      const outputPath = requestUrl.pathname.slice(1);
      const artifacts =
        typeof serverMod.generateLlmsTxtArtifacts === "function"
          ? await serverMod.generateLlmsTxtArtifacts()
          : requestUrl.pathname === LLMS_TXT_PATH
            ? [{ outputPath: "llms.txt", content: await serverMod.generateLlmsTxt() }]
            : [];
      const artifact = artifacts.find(
        (candidate: { outputPath?: unknown }) => candidate?.outputPath === outputPath,
      );
      if (!artifact || typeof artifact.content !== "string") {
        return next();
      }

      const routeMatchers = {
        app: serverMod.resolvedApp as ResolvedPrachtApp,
        apiRoutes: serverMod.apiRoutes as ResolvedApiRoute[],
        matchApiRoute: framework.matchApiRoute,
        matchAppRoute: framework.matchAppRoute,
      };
      if (!warnedRouteCollision && matchesResolvedRoute(requestUrl.pathname, routeMatchers)) {
        warnedRouteCollision = true;
        server.config.logger.warn(
          `[pracht] An app route matches ${requestUrl.pathname}, which is reserved by the ` +
            `pracht({ llmsTxt }) option. The generated artifact wins; disable the option ` +
            `to serve the app route instead.`,
        );
      }

      if (
        typeof server.config.publicDir === "string" &&
        !warnedPublicCollisions.has(outputPath) &&
        existsSync(join(server.config.publicDir, outputPath))
      ) {
        warnedPublicCollisions.add(outputPath);
        server.config.logger.warn(
          `[pracht] public/${outputPath} is shadowed by the generated llms.txt artifact in ` +
            `development and overwritten during production builds. Remove it, or disable the ` +
            `plugin's llmsTxt option to hand-author the file.`,
        );
      }

      res.statusCode = 200;
      res.setHeader(
        "content-type",
        artifact.outputPath.endsWith(".md")
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8",
      );
      applyDefaultSecurityHeaders(new Headers()).forEach((value, key) => {
        res.setHeader(key, value);
      });
      res.end(artifact.content);
    } catch (error: unknown) {
      await handleDevError(server, req, res, next, url, error);
    }
  };
}

export function createDevSSRMiddleware(
  server: ViteDevServer,
  options: { maxBodySize?: number } = {},
): Connect.NextHandleFunction {
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  let warnedDevtoolsCollision = false;
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const requestUrl = new URL(url, "http://localhost");

    try {
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);

      const routeMatchers = {
        app: serverMod.resolvedApp as ResolvedPrachtApp,
        apiRoutes: serverMod.apiRoutes as ResolvedApiRoute[],
        matchApiRoute: framework.matchApiRoute,
        matchAppRoute: framework.matchAppRoute,
      };

      // `/_pracht` is reserved in dev only. Production builds never see this
      // branch, so a user route at that path keeps working in production.
      if (requestUrl.pathname === DEVTOOLS_PATH || requestUrl.pathname === DEVTOOLS_JSON_PATH) {
        if (!warnedDevtoolsCollision && matchesResolvedRoute(requestUrl.pathname, routeMatchers)) {
          warnedDevtoolsCollision = true;
          server.config.logger.warn(
            `[pracht] An app route matches ${requestUrl.pathname}, which is reserved for the ` +
              `pracht devtools page in dev. The devtools page wins during development; the app ` +
              `route is only served in production builds.`,
          );
        }

        await serveDevtools(server, res, {
          apiRoutes: serverMod.apiRoutes ?? [],
          app: serverMod.resolvedApp,
          url,
          wantsJson: requestUrl.pathname === DEVTOOLS_JSON_PATH,
        });
        return;
      }

      if (shouldBypassDevSSR(requestUrl, req, routeMatchers)) {
        return next();
      }

      if (isDevNotFoundRequest(requestUrl, req, routeMatchers)) {
        return serveDevNotFound(server, res, next, url, requestUrl.pathname, routeMatchers);
      }

      let webRequest: Request;
      try {
        webRequest = await nodeToWebRequest(req, maxBodySize);
      } catch (err) {
        if (err instanceof Error && err.message === "Request body too large") {
          res.statusCode = 413;
          res.end("Payload Too Large");
          return;
        }
        throw err;
      }
      // Dev-only: collect middleware/loader/render phase durations so the
      // browser Network panel shows them via the Server-Timing header.
      const timings: PrachtPhaseTimings = {};
      const response = await framework.handlePrachtRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
        debugErrors: true,
        clientEntryUrl: CLIENT_BROWSER_PATH,
        islandsEntryUrl: ISLANDS_CLIENT_BROWSER_PATH,
        islandsBootstrapRequired: serverMod.islandsBootstrapRequired === true,
        apiRoutes: serverMod.apiRoutes,
        timings,
      });

      // A 404 from the runtime normally falls through to Vite (which has
      // already had its shot at static files, since this middleware is
      // installed after Vite's own). Two exceptions are served as-is: apps
      // that declare a `notFound` page get that page rendered here — same as
      // in production — and JSON 404s are typed API responses (route-state,
      // capability envelopes) that must reach the client untouched.
      const responseContentType = response.headers.get("content-type") ?? "";
      if (
        response.status === 404 &&
        !responseContentType.includes("application/json") &&
        !routeMatchers.app?.notFound
      ) {
        return next();
      }

      // Only transform what actually is HTML. Defaulting a missing
      // content-type to `text/html` made Vite inject its client script into
      // bodiless responses — an MCP `notifications/*` 202 came back with
      // `<script type="module" src="/@vite/client">` as its body, and so did
      // redirects.
      const contentType = response.headers.get("content-type") ?? "";
      let body = await response.text();

      if (contentType.includes("text/html")) {
        body = await server.transformIndexHtml(url, body);
      }

      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value);
      });
      const serverTiming = framework.formatServerTimingHeader(timings);
      if (serverTiming) {
        res.setHeader("Server-Timing", serverTiming);
      }
      res.end(body);
    } catch (error: unknown) {
      await handleDevError(server, req, res, next, url, error);
    }
  };
}

/**
 * Build the development equivalent of the production CSS manifest for the
 * current route. Vite turns CSS imports into client-side style injection by
 * default; resolving the same imports through the active server environment
 * graphs lets pracht put real stylesheet links in the initial document and
 * avoid a first-paint FOUC.
 */
export async function createDevCssManifest(
  server: ViteDevServer,
  options: {
    app: ResolvedPrachtApp;
    matchAppRoute: (
      app: ResolvedPrachtApp,
      pathname: string,
    ) => { route: ResolvedRoute } | undefined;
    pathname: string;
    registry: ModuleRegistry;
  },
): Promise<Record<string, string[]>> {
  const route = options.matchAppRoute(options.app, options.pathname)?.route ?? options.app.notFound;
  if (!route) return {};

  const manifest: Record<string, string[]> = {};
  const modules = [
    ...(route.shellFile
      ? [{ file: route.shellFile, registry: options.registry.shellModules }]
      : []),
    { file: route.file, registry: options.registry.routeModules },
  ];

  const results = await Promise.all(
    modules.map(async ({ file, registry }) => {
      if (!registry) return { file, urls: [] };
      const moduleKey = findRegistryModuleKey(registry, file);
      if (!moduleKey) return { file, urls: [] };

      // Adapters can name their server environment (for example, Cloudflare
      // does), so inspect every graph instead of assuming `ssr`.
      const entries = await Promise.all(
        Object.values(server.environments).map((environment) =>
          environment.moduleGraph.getModuleByUrl(moduleKey),
        ),
      );
      const urls = [...new Set(entries.flatMap((entry) => collectDevCssUrls(entry)))];
      return { file, urls };
    }),
  );

  for (const { file, urls } of results) {
    if (urls.length > 0) manifest[file] = urls;
  }

  return manifest;
}

function findRegistryModuleKey(
  modules: Record<string, () => Promise<unknown>> | undefined,
  file: string,
): string | undefined {
  if (!modules) return undefined;
  if (file in modules) return file;

  const suffix = `/${file
    .split("?")[0]
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")}`;
  return Object.keys(modules).find((key) => key.split("?")[0].replace(/\\/g, "/").endsWith(suffix));
}

export function collectDevCssUrls(entry: EnvironmentModuleNode | undefined): string[] {
  if (!entry) return [];

  const urls = new Set<string>();
  const visited = new Set<EnvironmentModuleNode>();
  const pending = [entry];

  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);

    // SSR transforms CSS imports into JavaScript modules, so Vite can label
    // these nodes as `js`. The URL remains the reliable signal for CSS and
    // preprocessor requests; asset/string queries are intentionally excluded.
    if (
      (module.type === "css" || CSS_MODULE_URL_RE.test(module.url)) &&
      !/[?&](?:inline|raw|url)(?:[=&]|$)/.test(module.url)
    ) {
      urls.add(module.url);
    }
    pending.push(...[...module.importedModules].reverse());
  }

  return [...urls];
}

export function injectDevCssLinks(html: string, manifest: Record<string, string[]>): string {
  if (!html.includes("</head>")) return html;

  const urls = [...new Set(Object.values(manifest).flat())];
  const tags = urls
    .map((url) => escapeHtmlAttribute(url))
    .filter((escapedUrl) => !html.includes(`href="${escapedUrl}"`))
    .map((escapedUrl) => `<link rel="stylesheet" href="${escapedUrl}">`);
  if (tags.length === 0) return html;

  return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}

export async function injectDevCssForPath(
  server: ViteDevServer,
  path: string,
  html: string,
): Promise<string> {
  const context = await resolveDevCssContextForPath(server, path);
  const manifest = await createDevCssManifest(server, context);
  return injectDevCssLinks(html, manifest);
}

async function resolveDevCssContextForPath(
  server: ViteDevServer,
  path: string,
): Promise<Parameters<typeof createDevCssManifest>[1]> {
  const [framework, serverMod] = await Promise.all([
    server.ssrLoadModule("@pracht/core/server"),
    server.ssrLoadModule(PRACHT_DEV_MODULE_ID),
  ]);
  const pathname = new URL(path, "http://localhost").pathname;
  return {
    app: serverMod.resolvedApp,
    matchAppRoute: framework.matchAppRoute,
    pathname,
    registry: serverMod.registry,
  };
}

/**
 * Adapter-owned dev servers (for example Cloudflare's worker runtime) bypass
 * Vite's HTML transform hooks. Install this before the adapter middleware so
 * document responses still receive the same parser-blocking stylesheet links.
 */
export function createDevCssInjectionMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  let warned = false;
  return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const method = (req.method ?? "GET").toUpperCase();
    const accept = readRequestHeader(req.headers.accept).toLowerCase();
    if (method !== "GET" || !accept.includes("text/html")) {
      next();
      return;
    }

    // Resolve the route before the adapter begins its request. Remote dev
    // runtimes can serialize module-runner work while a response is open. CSS
    // traversal itself waits until res.end(), after that runtime has populated
    // its environment graph with the matched route and shell.
    const contextPromise = resolveDevCssContextForPath(server, req.url ?? "/").catch((error) => {
      if (!warned) {
        warned = true;
        server.config.logger.warn(
          `[pracht] Could not discover development stylesheets: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    });
    const chunks: Buffer[] = [];
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    res.writeHead = ((statusCode: number, ...args: unknown[]) => {
      res.removeHeader("content-length");
      return Reflect.apply(originalWriteHead, res, [
        statusCode,
        ...args.map(stripContentLengthHeader),
      ]);
    }) as typeof res.writeHead;

    res.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      chunks.push(toBuffer(chunk, encodingOrCallback));
      const done: (() => void) | undefined =
        typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : typeof callback === "function"
            ? (callback as () => void)
            : undefined;
      done?.();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      if (chunk != null) chunks.push(toBuffer(chunk, encodingOrCallback));
      const done: (() => void) | undefined =
        typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : typeof callback === "function"
            ? (callback as () => void)
            : undefined;

      void (async () => {
        const body = Buffer.concat(chunks);
        const contentType = String(res.getHeader("content-type") ?? "");
        if (!contentType.includes("text/html")) {
          originalEnd(body, done);
          return;
        }

        try {
          const context = await contextPromise;
          const manifest = context ? await createDevCssManifest(server, context) : null;
          const html = manifest
            ? injectDevCssLinks(body.toString("utf-8"), manifest)
            : body.toString("utf-8");
          originalEnd(html, done);
        } catch {
          originalEnd(body, done);
        }
      })();

      return res;
    }) as typeof res.end;

    next();
  };
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(
    String(chunk),
    typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
  );
}

function stripContentLengthHeader(value: unknown): unknown {
  if (Array.isArray(value)) {
    const headers: unknown[] = [];
    for (let index = 0; index < value.length; index += 2) {
      if (String(value[index]).toLowerCase() !== "content-length") {
        headers.push(value[index], value[index + 1]);
      }
    }
    return headers;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([name]) => name.toLowerCase() !== "content-length"),
    );
  }

  return value;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Serve the dev-only `/_pracht` devtools page (or `/_pracht.json`) built from
 * the same resolved app graph that `pracht inspect` reports.
 */
async function serveDevtools(
  server: ViteDevServer,
  res: ServerResponse,
  options: {
    apiRoutes: ResolvedApiRoute[];
    app: ResolvedPrachtApp;
    url: string;
    wantsJson: boolean;
  },
): Promise<void> {
  const devtools = await server.ssrLoadModule("@pracht/core/devtools");
  // Manifest capability paths are relative to the app file (e.g.
  // `./capabilities/notes-search.ts`), which a bare ssrLoadModule resolves
  // against the Vite root and fails to find. Resolve through the virtual
  // server module's registry first (matching `pracht inspect`), falling back
  // to a direct load for absolute/root-relative paths.
  const serverModule = (await server.ssrLoadModule(PRACHT_SERVER_MODULE_ID)) as {
    registry?: { capabilityModules?: Record<string, () => Promise<unknown>> };
  };
  const capabilityModules = serverModule.registry?.capabilityModules;
  const graph = await devtools.buildAppGraph({
    apiRoutes: options.apiRoutes,
    app: options.app,
    loadModule: async (file: string) => {
      const viaRegistry = await resolveRegistryModule<Record<string, unknown>>(
        capabilityModules,
        file,
      );
      return viaRegistry ?? server.ssrLoadModule(file);
    },
    readSource: (file: string) => readFileSync(resolve(server.config.root, `.${file}`), "utf-8"),
  });

  if (options.wantsJson) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(graph, null, 2));
    return;
  }

  let html = devtools.buildDevtoolsHtml(graph);
  html = await server.transformIndexHtml(options.url, html);
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleDevError(
  server: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
  url: string,
  error: unknown,
): Promise<void> {
  if (error instanceof Error) {
    server.ssrFixStacktrace(error);
  }

  const isRouteState = req.headers["x-pracht-route-state-request"] === "1";
  if (isRouteState) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          status: 500,
        },
      }),
    );
    return;
  }

  try {
    const { buildErrorOverlayHtml } = await server.ssrLoadModule("@pracht/core/error-overlay");
    let html = buildErrorOverlayHtml({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      root: server.config.root,
    });
    html = await server.transformIndexHtml(url, html);
    res.statusCode = 500;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    next(error);
  }
}

/**
 * True when a GET/HEAD document request matches no page route and no API
 * route — the dev middleware then serves the rich dev-only 404 page instead
 * of falling through to Vite. Route-state (JSON) requests and non-document
 * fetches keep their existing 404 behavior.
 *
 * Apps that declare a `notFound` page own their 404s: dev renders that page
 * (exactly as production does) rather than the framework's route table.
 */
export function isDevNotFoundRequest(
  requestUrl: URL | string,
  req: Pick<IncomingMessage, "headers" | "method">,
  options: {
    app?: ResolvedPrachtApp;
    apiRoutes?: ResolvedApiRoute[];
    matchApiRoute?: (routes: ResolvedApiRoute[], pathname: string) => unknown;
    matchAppRoute?: (app: ResolvedPrachtApp, pathname: string) => unknown;
  } = {},
): boolean {
  const url = typeof requestUrl === "string" ? new URL(requestUrl, "http://localhost") : requestUrl;

  if (options.app?.notFound) {
    return false;
  }

  if (isRouteStateRequest(url, req)) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const accept = readRequestHeader(req.headers.accept).toLowerCase();
  if (!accept.includes("text/html") && !accept.includes("application/xhtml+xml")) {
    return false;
  }

  return !matchesResolvedRoute(url.pathname, options);
}

async function serveDevNotFound(
  server: ViteDevServer,
  res: ServerResponse,
  next: Connect.NextFunction,
  url: string,
  pathname: string,
  options: { app: ResolvedPrachtApp; apiRoutes: ResolvedApiRoute[] },
): Promise<void> {
  try {
    const { buildDevNotFoundHtml } = await server.ssrLoadModule("@pracht/core/dev-404");
    let html = buildDevNotFoundHtml({
      apiRoutes: options.apiRoutes.map((route) => ({ path: route.path })),
      requestedPath: pathname,
      routes: options.app.routes.map((route) => ({
        path: route.path,
        render: route.render ?? null,
      })),
    });
    html = await server.transformIndexHtml(url, html);
    res.statusCode = 404;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    next();
  }
}

export function shouldBypassDevSSR(
  requestUrl: URL | string,
  req: Pick<IncomingMessage, "headers" | "method">,
  options: {
    app?: ResolvedPrachtApp;
    apiRoutes?: ResolvedApiRoute[];
    matchApiRoute?: (routes: ResolvedApiRoute[], pathname: string) => unknown;
    matchAppRoute?: (app: ResolvedPrachtApp, pathname: string) => unknown;
  } = {},
): boolean {
  const url = typeof requestUrl === "string" ? new URL(requestUrl, "http://localhost") : requestUrl;
  const pathname = url.pathname;

  if (isReservedDevPath(pathname)) {
    return true;
  }

  if (isRouteStateRequest(url, req)) {
    return false;
  }

  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  if (isApiRequest) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const fetchDest = readRequestHeader(req.headers["sec-fetch-dest"]).toLowerCase();
  const hasRouteMatch = matchesResolvedRoute(pathname, options);

  if (hasRouteMatch && !NON_DOCUMENT_FETCH_DESTINATIONS.has(fetchDest)) {
    return false;
  }

  if (NON_DOCUMENT_FETCH_DESTINATIONS.has(fetchDest)) {
    return true;
  }

  const accept = readRequestHeader(req.headers.accept).toLowerCase();
  if (accept.includes("text/html") || accept.includes("application/xhtml+xml")) {
    return false;
  }

  return hasKnownAssetExtension(pathname);
}

function matchesResolvedRoute(
  pathname: string,
  options: {
    app?: ResolvedPrachtApp;
    apiRoutes?: ResolvedApiRoute[];
    matchApiRoute?: (routes: ResolvedApiRoute[], pathname: string) => unknown;
    matchAppRoute?: (app: ResolvedPrachtApp, pathname: string) => unknown;
  },
): boolean {
  if (options.app && options.matchAppRoute && options.matchAppRoute(options.app, pathname)) {
    return true;
  }

  if (
    options.apiRoutes?.length &&
    options.matchApiRoute &&
    options.matchApiRoute(options.apiRoutes, pathname)
  ) {
    return true;
  }

  return false;
}

function isRouteStateRequest(url: URL, req: Pick<IncomingMessage, "headers" | "method">): boolean {
  return (
    req.headers["x-pracht-route-state-request"] === "1" || url.searchParams.get("_data") === "1"
  );
}

function readRequestHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return value ?? "";
}

function hasKnownAssetExtension(pathname: string): boolean {
  const fileName = pathname.split("/").pop() ?? "";
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return false;
  }

  const extension = fileName.slice(extensionIndex).toLowerCase();
  return DEV_ASSET_EXTENSIONS.has(extension);
}

function isReservedDevPath(pathname: string): boolean {
  return (
    pathname === CLIENT_BROWSER_PATH ||
    pathname === ISLANDS_CLIENT_BROWSER_PATH ||
    pathname === "/@vite/client" ||
    pathname === "/@react-refresh" ||
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/__vite_")
  );
}

const NON_DOCUMENT_FETCH_DESTINATIONS = new Set([
  "audio",
  "embed",
  "font",
  "image",
  "manifest",
  "object",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "worker",
]);

const DEV_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".cjs",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".markdown",
  ".md",
  ".mjs",
  ".pdf",
  ".png",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
]);

async function nodeToWebRequest(req: IncomingMessage, maxBodySize: number): Promise<Request> {
  // Dev server is always a direct connection — never trust forwarded headers.
  // Protocol is always plain HTTP (Vite's dev server does not use TLS), and
  // host comes from the standard Host header which is safe for direct clients.
  const protocol = "http";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalSize += buf.byteLength;
      if (totalSize > maxBodySize) {
        throw new Error("Request body too large");
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return new Request(url, init);
}
