/** Development error-overlay and rich not-found response rendering. */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Connect, ViteDevServer } from "vite";
import type { ResolvedApiRoute, ResolvedPrachtApp } from "@pracht/core";

export async function handleDevError(
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

export async function serveDevNotFound(
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
