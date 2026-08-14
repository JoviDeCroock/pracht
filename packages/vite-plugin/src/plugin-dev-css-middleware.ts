import type { IncomingMessage, ServerResponse } from "node:http";

import type { Connect, ViteDevServer } from "vite";

import { createDevCssManifest } from "./plugin-dev-css-graph.ts";
import { injectDevCssLinks } from "./plugin-dev-css-html.ts";
import { resolveDevCssContextForPath } from "./plugin-dev-css-route.ts";

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

function readRequestHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}
