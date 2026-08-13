import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Connect, ViteDevServer } from "vite";

import { PRACHT_DEV_MODULE_ID } from "./graph-codegen.ts";
import type { PrachtOpenApiArtifacts, ResolvedPrachtOpenApiOptions } from "./model.ts";

export function createOpenApiDevMiddleware(
  server: ViteDevServer,
  options: ResolvedPrachtOpenApiOptions,
  warned: Set<string>,
): Connect.NextHandleFunction {
  const endpointPaths = new Set([
    options.documentPath,
    ...(options.ui ? [options.ui.path, `${options.ui.path}/`] : []),
  ]);

  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (!endpointPaths.has(requestUrl.pathname)) return next();

    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return;
    }

    try {
      const [framework, serverModule] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_DEV_MODULE_ID),
      ]);
      const collisionKey = `route:${requestUrl.pathname}`;
      if (
        !warned.has(collisionKey) &&
        (framework.matchAppRoute?.(serverModule.resolvedApp, requestUrl.pathname) ||
          framework.matchApiRoute?.(serverModule.apiRoutes, requestUrl.pathname))
      ) {
        warned.add(collisionKey);
        server.config.logger.warn(
          `[pracht:openapi] An app route matches reserved path ${requestUrl.pathname}. ` +
            "The OpenAPI endpoint wins while the companion plugin is enabled.",
        );
      }
      const generate = serverModule.generatePrachtOpenApiArtifacts;
      if (typeof generate !== "function") {
        throw new Error(
          "OpenAPI graph hook is missing. Place prachtOpenApi() after pracht() in vite.config.ts.",
        );
      }
      const result = (await generate()) as PrachtOpenApiArtifacts;
      for (const warning of result.warnings) {
        const key = JSON.stringify(warning);
        if (warned.has(key)) continue;
        warned.add(key);
        server.config.logger.warn(
          `[pracht:openapi] ${warning.method ? `${warning.method} ` : ""}${warning.path}: ${warning.message}`,
        );
      }

      const canonicalPath = requestUrl.pathname.endsWith("/")
        ? requestUrl.pathname.slice(0, -1)
        : requestUrl.pathname;
      const artifact = result.artifacts.find((candidate) => candidate.path === canonicalPath);
      if (!artifact) return next();

      res.statusCode = 200;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", artifact.contentType);
      res.setHeader("x-content-type-options", "nosniff");
      res.end(method === "HEAD" ? undefined : artifact.content);
    } catch (error) {
      if (error instanceof Error) server.ssrFixStacktrace(error);
      server.config.logger.error(
        `[pracht:openapi] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      res.statusCode = 500;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("OpenAPI generation failed");
    }
  };
}

export function warnPublicArtifactCollisions(
  server: ViteDevServer,
  options: ResolvedPrachtOpenApiOptions,
): void {
  if (typeof server.config.publicDir !== "string") return;
  const outputPaths = [
    options.documentPath.slice(1),
    ...(options.ui ? [`${options.ui.path.slice(1)}/index.html`] : []),
  ];
  for (const outputPath of outputPaths) {
    if (!existsSync(join(server.config.publicDir, outputPath))) continue;
    server.config.logger.warn(
      `[pracht:openapi] public/${outputPath} collides with a generated OpenAPI artifact. ` +
        "The companion endpoint wins in development and pracht build replaces the public file.",
    );
  }
}
