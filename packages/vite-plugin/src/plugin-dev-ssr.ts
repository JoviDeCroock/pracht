import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { CLIENT_BROWSER_PATH, PRACHT_SERVER_MODULE_ID } from "./plugin-assets.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

export function createDevSSRMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const pathname = new URL(url, "http://localhost").pathname;

    // Let Vite handle assets by pathname. Query params may contain dotted
    // domains or tokens, but they should not opt the route out of SSR.
    if (pathname.includes(".") || pathname.startsWith("/node_modules/")) {
      return next();
    }

    try {
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);

      let webRequest: Request;
      try {
        webRequest = await nodeToWebRequest(req);
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
    const { buildErrorOverlayHtml } = await server.ssrLoadModule("pracht/error-overlay");
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

async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
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
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
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
