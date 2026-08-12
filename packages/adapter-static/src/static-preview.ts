import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import { getCacheControl, resolveStaticFile } from "@pracht/adapter-node";

export interface StaticPreviewHandlerOptions {
  /** Directory to serve, usually `dist/client`. */
  staticDir: string;
  /**
   * SPA fallback file name (e.g. `"200.html"`). When set and present in
   * `staticDir`, unmatched URLs are answered with its contents and status
   * 200 — mirroring a host-level rewrite rule. When unset, unmatched URLs
   * are answered with `404.html` (status 404) when it exists.
   */
  fallback?: string | null;
}

/**
 * A deliberately tiny static file server for `pracht preview` of static
 * exports. It mirrors what a plain static host does — files, clean-URL
 * `index.html` resolution, `404.html` for misses, an optional SPA fallback —
 * and nothing else: no route matching, no loaders, no framework runtime.
 * Production deploys should use a real static host; this exists so the build
 * output can be exercised locally with one command.
 */
export function createStaticPreviewHandler(
  options: StaticPreviewHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const staticDir = resolve(options.staticDir);
  const fallback = options.fallback ?? null;

  return async function handleStaticPreviewRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    const file = await resolveStaticFile(staticDir, pathname);
    if (file) {
      await sendFile(res, method, file.filePath, file.contentType, file.cacheControl, 200);
      return;
    }

    if (fallback) {
      const fallbackFile = await resolveStaticFile(staticDir, `/${fallback}`);
      if (fallbackFile) {
        // Mirrors a host rewrite: the SPA fallback document answers any URL
        // with status 200 so the client router can resolve the real route.
        await sendFile(
          res,
          method,
          fallbackFile.filePath,
          "text/html; charset=utf-8",
          "no-cache",
          200,
        );
        return;
      }
    }

    const notFoundFile = await resolveStaticFile(staticDir, "/404.html");
    if (notFoundFile) {
      await sendFile(
        res,
        method,
        notFoundFile.filePath,
        "text/html; charset=utf-8",
        "no-cache",
        404,
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  };
}

async function sendFile(
  res: ServerResponse,
  method: string,
  filePath: string,
  contentType: string,
  cacheControl: string,
  status: number,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "content-length": body.byteLength,
  });
  res.end(method === "HEAD" ? undefined : body);
}

export { getCacheControl };
