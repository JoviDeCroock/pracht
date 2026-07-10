import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Connect, ViteDevServer } from "vite";
import type { PrachtPhaseTimings, ResolvedApiRoute, ResolvedPrachtApp } from "@pracht/core";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  PRACHT_SERVER_MODULE_ID,
} from "./plugin-assets.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

export const DEVTOOLS_PATH = "/_pracht";
export const DEVTOOLS_JSON_PATH = "/_pracht.json";

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
        apiRoutes: serverMod.apiRoutes,
        timings,
      });

      // JSON 404s are typed API responses (route-state, capability envelopes)
      // and must reach the client as-is; only non-JSON 404s fall through to
      // Vite / the dev not-found page.
      const responseContentType = response.headers.get("content-type") ?? "";
      if (response.status === 404 && !responseContentType.includes("application/json")) {
        return next();
      }

      const contentType = response.headers.get("content-type") ?? "text/html";
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
  const graph = await devtools.buildAppGraph({
    apiRoutes: options.apiRoutes,
    app: options.app,
    loadModule: (file: string) => server.ssrLoadModule(file),
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
