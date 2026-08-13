/** Node request orchestration and terminal HTTP error handling. */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  isCacheableISGResponse,
  PRACHT_REVALIDATE_ENDPOINT,
  prefersMarkdown,
  preventHeuristicCaching,
  routeSupportsMarkdown,
} from "@pracht/core/server";
import { handleRevalidationEndpoint, persistISGSnapshot, serveISGEntry } from "./node-isg.ts";
import { isClientDisconnectError } from "./node-disconnect.ts";
import { createWebRequest } from "./node-request.ts";
import { writeWebResponse } from "./node-response.ts";
import { resolveStaticFile, serveStaticFile } from "./node-static.ts";
import type { NodeAdapterOptions } from "./node-types.ts";

export type { NodeAdapterContextArgs, NodeAdapterOptions } from "./node-types.ts";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

let warnedAboutMissingCanonicalOrigin = false;

export function createNodeRequestHandler<TContext = unknown>(
  options: NodeAdapterOptions<TContext>,
) {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const staticDir = options.staticDir;
  const trustProxy = options.trustProxy ?? false;
  const canonicalOrigin = options.canonicalOrigin;
  const maxBodySize = options.maxBodySize;

  if (maxBodySize !== undefined && (!Number.isInteger(maxBodySize) || maxBodySize <= 0)) {
    throw new Error("nodeAdapter({ maxBodySize }) expects a positive integer number of bytes.");
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!canonicalOrigin && shouldWarnAboutMissingCanonicalOrigin(staticDir)) {
      warnedAboutMissingCanonicalOrigin = true;
      console.warn(
        "[pracht] @pracht/adapter-node is deriving request.url from Host headers. Set nodeAdapter({ canonicalOrigin }) for deployed Node apps to avoid host-header poisoning.",
      );
    }

    let request: Request;
    try {
      request = await createWebRequest(req, { canonicalOrigin, trustProxy, maxBodySize });
    } catch (err) {
      if (err instanceof Error && err.message === "Request body too large") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }
    const url = new URL(request.url);
    const isTransportRouteStateRequest = isRouteStateRequest(url, request.headers);
    // Only routes that can actually answer with markdown skip the static and
    // ISG fast paths: the client has to prefer markdown over HTML (a browser's
    // `*/*` or a q-weighted `text/markdown;q=0.1` does not), and the route has
    // to appear in the exact markdown manifest emitted by the build. Missing
    // metadata means a legacy/custom entry, so preserve correct negotiation by
    // falling through as older adapters did.
    const wantsMarkdown =
      prefersMarkdown(request.headers.get("accept")) &&
      (options.markdownManifest === undefined ||
        routeSupportsMarkdown(options.markdownManifest, url.pathname));

    if (url.pathname === PRACHT_REVALIDATE_ENDPOINT) {
      const response = await handleRevalidationEndpoint(request, options, staticDir, isgManifest, {
        request,
        req,
        res,
      });
      await writeWebResponse(res, response);
      return;
    }

    if (
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !wantsMarkdown &&
      !isTransportRouteStateRequest
    ) {
      const staticResult = await resolveStaticFile(staticDir, url.pathname, isgManifest);
      if (staticResult) {
        await serveStaticFile(request, res, staticResult, headersManifest, url.pathname);
        return;
      }
    }

    if (
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !isTransportRouteStateRequest &&
      !wantsMarkdown &&
      url.pathname in isgManifest
    ) {
      const served = await serveISGEntry(
        request,
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
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    const isIsgDocument =
      staticDir !== undefined &&
      request.method === "GET" &&
      !isTransportRouteStateRequest &&
      url.pathname in isgManifest &&
      response.status === 200 &&
      (response.headers.get("content-type")?.includes("text/html") ?? false) &&
      isCacheableISGResponse(response);

    if (isIsgDocument) {
      await persistISGSnapshot(staticDir, url.pathname, response);
    }

    // Evaluated after the ISG snapshot decision above: stamping a
    // `Cache-Control` first would make `isCacheableISGResponse()` reject the
    // very response it was about to persist. A reverse proxy or CDN in front of
    // a Node deployment can otherwise apply heuristic freshness to an
    // authenticated SSR page — the same hazard the Cloudflare adapter guards.
    //
    // ISG documents are exempt. This response is the cold render of a page that
    // every later request answers from disk with
    // `public, max-age=0, must-revalidate`; stamping only the cold one would
    // make a route's caching headers depend on whether its snapshot exists yet.
    await writeWebResponse(
      res,
      isIsgDocument ? response : preventHeuristicCaching(request, response),
    );
  };

  // `http.createServer(handler)` ignores the returned promise, so a rejection
  // here would become an unhandled rejection and terminate the process. Every
  // failure has to be absorbed at this boundary.
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handle(req, res);
    } catch (error) {
      // A disconnect-shaped error code is not on its own evidence that the
      // client left: `createContext`, a loader, or a pooled database client can
      // all throw `Error { code: "ECONNRESET" }` from a *server-side* socket.
      // Only skip the error path when the connection is genuinely unusable,
      // otherwise a real failure would return without ever ending the response
      // and the request would hang until `server.requestTimeout`.
      const connectionGone = req.destroyed || res.destroyed || !res.writable;
      if (connectionGone && isClientDisconnectError(error)) {
        if (!res.destroyed) res.destroy();
        return;
      }

      console.error("[pracht] Unhandled error while serving a request:", error);

      if (res.destroyed || res.headersSent || res.writableEnded) {
        // Either nothing can be written any more, or the client already has a
        // partial response and appending a 500 body would corrupt it.
        if (!res.destroyed) res.destroy();
        return;
      }

      try {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      } catch {
        res.destroy();
      }
    }
  };
}

function shouldWarnAboutMissingCanonicalOrigin(staticDir: string | undefined): boolean {
  if (warnedAboutMissingCanonicalOrigin) return false;
  if (process.env.NODE_ENV === "production") return true;
  return typeof staticDir === "string" && staticDir.length > 0;
}

function isRouteStateRequest(url: URL, headers: Headers): boolean {
  return headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" || url.searchParams.get("_data") === "1";
}

function isStaticAssetMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
