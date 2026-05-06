import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import type { ResolvedApiRoute, ResolvedPrachtApp } from "@pracht/core";
import { CLIENT_BROWSER_PATH, PRACHT_SERVER_MODULE_ID } from "./plugin-assets.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

export function createDevSSRMiddleware(
  server: ViteDevServer,
  options: { maxBodySize?: number } = {},
): Connect.NextHandleFunction {
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const requestUrl = new URL(url, "http://localhost");

    try {
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);

      if (
        shouldBypassDevSSR(requestUrl, req, {
          app: serverMod.resolvedApp,
          apiRoutes: serverMod.apiRoutes,
          matchApiRoute: framework.matchApiRoute,
          matchAppRoute: framework.matchAppRoute,
        })
      ) {
        return next();
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
      const response = await framework.handlePrachtRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
        debugErrors: true,
        clientEntryUrl: CLIENT_BROWSER_PATH,
        apiRoutes: serverMod.apiRoutes,
      });

      if (response.status === 404) {
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
      res.end(body);
    } catch (error: unknown) {
      await handleDevError(server, req, res, next, url, error);
    }
  };
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
    });
    html = await server.transformIndexHtml(url, html);
    res.statusCode = 500;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    next(error);
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
