import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import {
  applyDefaultSecurityHeaders,
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core";

import { regenerateISGPage } from "./node-isg.ts";
import { createWebRequest, writeWebResponse } from "./node-request.ts";
import { applyHeadersManifest, resolveStaticFile, type HeadersManifest } from "./node-static.ts";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

export interface NodeAdapterContextArgs {
  request: Request;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface NodeAdapterOptions<TContext = unknown> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  staticDir?: string;
  viteManifest?: unknown;
  isgManifest?: Record<string, ISGManifestEntry>;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest;
  createContext?: (args: NodeAdapterContextArgs) => TContext | Promise<TContext>;
  /**
   * Whether to trust proxy headers (`Forwarded`, `X-Forwarded-Proto`,
   * `X-Forwarded-Host`) when constructing the request URL.
   *
   * When **false** (the default), the request URL is derived from the socket:
   * protocol is inferred from TLS state, and host from the `Host` header.
   * Forwarded headers are ignored, preventing host-header poisoning.
   *
   * When **true**, forwarded headers are honored with the following precedence:
   *   1. RFC 7239 `Forwarded` header (`proto=` and `host=` directives)
   *   2. `X-Forwarded-Proto` / `X-Forwarded-Host`
   *   3. Socket-derived values (fallback)
   *
   * Enable this only when the Node server sits behind a trusted reverse proxy
   * (e.g. nginx, Cloudflare, a load balancer) that sets these headers.
   */
  trustProxy?: boolean;
}

export function createNodeRequestHandler<TContext = unknown>(
  options: NodeAdapterOptions<TContext>,
) {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const staticDir = options.staticDir;
  const trustProxy = options.trustProxy ?? false;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let request: Request;
    try {
      request = await createWebRequest(req, trustProxy);
    } catch (err) {
      if (err instanceof Error && err.message === "Request body too large") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }
    const url = new URL(request.url);
    const isRouteStateRequest = request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1";
    const wantsMarkdown = (request.headers.get("accept") ?? "").includes("text/markdown");

    if (staticDir && request.method === "GET" && !wantsMarkdown) {
      const staticResult = await resolveStaticFile(staticDir, url.pathname, isgManifest);
      if (staticResult) {
        await serveStaticFile(res, staticResult, headersManifest, url.pathname);
        return;
      }
    }

    if (
      staticDir &&
      request.method === "GET" &&
      !isRouteStateRequest &&
      !wantsMarkdown &&
      url.pathname in isgManifest
    ) {
      const served = await serveISGEntry(
        res,
        options,
        staticDir,
        url.pathname,
        isgManifest[url.pathname],
        headersManifest,
        { request, req, res },
      );
      if (served) return;
    }

    const context = options.createContext
      ? await options.createContext({ request, req, res })
      : undefined;

    const response = await handlePrachtRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    if (
      staticDir &&
      request.method === "GET" &&
      !isRouteStateRequest &&
      url.pathname in isgManifest &&
      response.status === 200 &&
      response.headers.get("content-type")?.includes("text/html")
    ) {
      const html = await response.clone().text();
      const htmlPath =
        url.pathname === "/"
          ? join(staticDir, "index.html")
          : join(staticDir, url.pathname, "index.html");
      await mkdir(dirname(htmlPath), { recursive: true });
      await writeFile(htmlPath, html, "utf-8");
    }

    await writeWebResponse(res, response);
  };
}

async function serveStaticFile(
  res: ServerResponse,
  staticResult: { filePath: string; contentType: string; cacheControl: string },
  headersManifest: HeadersManifest,
  pathname: string,
): Promise<void> {
  const body = await readFile(staticResult.filePath);
  res.statusCode = 200;
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": staticResult.contentType,
      "cache-control": staticResult.cacheControl,
    }),
  );
  if (staticResult.contentType.includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, pathname);
  }
  headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(body);
}

async function serveISGEntry<TContext>(
  res: ServerResponse,
  options: NodeAdapterOptions<TContext>,
  staticDir: string,
  pathname: string,
  entry: ISGManifestEntry,
  headersManifest: HeadersManifest,
  contextArgs: NodeAdapterContextArgs,
): Promise<boolean> {
  const htmlPath =
    pathname === "/" ? join(staticDir, "index.html") : join(staticDir, pathname, "index.html");

  const fileStat = await stat(htmlPath).catch(() => null);
  if (!fileStat?.isFile()) return false;

  const ageMs = Date.now() - fileStat.mtimeMs;
  const isStale = entry.revalidate.kind === "time" && ageMs > entry.revalidate.seconds * 1000;

  const html = await readFile(htmlPath, "utf-8");
  res.statusCode = 200;
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      vary: ROUTE_STATE_REQUEST_HEADER,
    }),
  );
  applyHeadersManifest(headers, headersManifest, pathname);
  headers.set("x-pracht-isg", isStale ? "stale" : "fresh");
  headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(html);

  if (isStale) {
    regenerateISGPage(options, pathname, htmlPath, contextArgs).catch((err) => {
      console.error(`ISG regeneration failed for ${pathname}:`, err);
    });
  }

  return true;
}
