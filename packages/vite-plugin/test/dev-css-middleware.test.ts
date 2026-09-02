import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import {
  createDevCssInjectionMiddleware,
  MAX_DEV_CSS_BUFFER_BYTES,
} from "../src/plugin-dev-ssr.ts";
import { PRACHT_DEV_MODULE_ID } from "../src/plugin-assets.ts";

function moduleNode(url: string, type: "js" | "css" = "js", importedModules: unknown[] = []) {
  return { importedModules: new Set(importedModules), type, url };
}

/**
 * The middleware wraps `res.write`/`writeHead`/`end`, so the fake has to be a
 * real writable stream — a plain object would hide both the backpressure
 * signal it used to discard and the fallback to streaming.
 */
function createResponse(options: { highWaterMark?: number } = {}) {
  const headers: Record<string, unknown> = {};
  const stream = new PassThrough({ highWaterMark: options.highWaterMark });
  const chunks: Buffer[] = [];
  const drain = () => {
    let chunk: Buffer | null;
    while ((chunk = stream.read() as Buffer | null) !== null) chunks.push(Buffer.from(chunk));
  };
  // Drain asynchronously so `write()` still reports backpressure at call time
  // but the stream can reach `finish`.
  stream.on("readable", drain);
  const finished = new Promise<void>((resolve) => {
    stream.on("end", () => {
      drain();
      resolve();
    });
  });
  const res = Object.assign(stream, {
    getHeader: (name: string) => headers[name.toLowerCase()],
    getHeaderNames: () => Object.keys(headers),
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    statusCode: 200,
    writeHead(status: number, ...args: unknown[]) {
      res.statusCode = status;
      for (const arg of args) {
        if (arg && typeof arg === "object" && !Array.isArray(arg)) {
          for (const [key, value] of Object.entries(arg)) headers[key.toLowerCase()] = value;
        }
      }
      return res;
    },
  }) as unknown as ServerResponse;

  return {
    finished,
    headers,
    res,
    get body() {
      drain();
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

function createServer(options: { failCssDiscovery?: boolean } = {}) {
  const logger = { error: vi.fn(), warn: vi.fn() };
  const routeEntry = moduleNode("/src/routes/about.tsx", "js", [
    moduleNode("/src/routes/about.css", "css"),
  ]);
  const server = {
    config: { base: "/", logger },
    environments: {
      ssr: {
        moduleGraph: {
          getModuleByUrl: async (url: string) => {
            if (options.failCssDiscovery) throw new Error("module runner is gone");
            return url === "/src/routes/about.tsx" ? routeEntry : undefined;
          },
        },
      },
    },
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") {
        return {
          matchAppRoute: (_app: unknown, pathname: string) =>
            pathname === "/about" ? { route: { file: "./routes/about.tsx" } } : undefined,
          stripBase: (pathname: string) => pathname,
        };
      }
      if (id === PRACHT_DEV_MODULE_ID) {
        return {
          registry: { routeModules: { "/src/routes/about.tsx": async () => ({}) } },
          resolvedApp: { routes: [] },
        };
      }
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
  } as unknown as ViteDevServer;

  return { logger, server };
}

function createRequest(): IncomingMessage {
  return {
    headers: { accept: "text/html,application/xhtml+xml" },
    method: "GET",
    url: "/about",
  } as unknown as IncomingMessage;
}

describe("dev CSS injection middleware", () => {
  it("injects stylesheets into an HTML document", async () => {
    const { server } = createServer();
    const response = createResponse();
    createDevCssInjectionMiddleware(server)(createRequest(), response.res, vi.fn());

    response.res.setHeader("content-type", "text/html; charset=utf-8");
    response.res.setHeader("content-length", "48");
    response.res.end("<html><head></head><body>hi</body></html>");
    await response.finished;

    expect(response.body).toContain('href="/src/routes/about.css"');
    // The injected links changed the length the handler declared.
    expect(response.headers["content-length"]).toBeUndefined();
  });

  // The old patch buffered every response and stripped `content-length` from
  // all of them, including responses it had no intention of rewriting.
  it("leaves a non-HTML response and its content-length alone", async () => {
    const { server } = createServer();
    const response = createResponse();
    createDevCssInjectionMiddleware(server)(createRequest(), response.res, vi.fn());

    response.res.setHeader("content-type", "application/json");
    response.res.setHeader("content-length", "13");
    response.res.end('{"ok":true}\n');
    await response.finished;

    expect(response.body).toBe('{"ok":true}\n');
    expect(response.headers["content-length"]).toBe("13");
  });

  it("keeps content-length when writeHead declares a non-HTML response", async () => {
    const { server } = createServer();
    const response = createResponse();
    createDevCssInjectionMiddleware(server)(createRequest(), response.res, vi.fn());

    response.res.writeHead(200, { "content-length": "5", "content-type": "image/png" });
    response.res.end("bytes");
    await response.finished;

    expect(response.headers["content-length"]).toBe("5");
    expect(response.body).toBe("bytes");
  });

  // `write()` unconditionally returned `true`, so a handler streaming a large
  // non-HTML body was told the socket was keeping up when it was not.
  it("reports real backpressure for a passthrough response", async () => {
    const { server } = createServer();
    const response = createResponse({ highWaterMark: 16 });
    createDevCssInjectionMiddleware(server)(createRequest(), response.res, vi.fn());

    response.res.setHeader("content-type", "application/octet-stream");
    const accepted = response.res.write(Buffer.alloc(64, 1));

    expect(accepted).toBe(false);
    response.res.end();
    await response.finished;
  });

  // A document past this size is not a document; holding it whole in memory to
  // look for `</head>` is worse than shipping it unmodified.
  it("stops buffering an oversized HTML body and streams it instead", async () => {
    const { server } = createServer();
    const response = createResponse();
    createDevCssInjectionMiddleware(server)(createRequest(), response.res, vi.fn());

    response.res.setHeader("content-type", "text/html");
    response.res.write("<html><head></head><body>");
    response.res.write(Buffer.alloc(MAX_DEV_CSS_BUFFER_BYTES, 0x61));
    response.res.end("</body></html>");
    await response.finished;

    expect(response.body.length).toBe(
      MAX_DEV_CSS_BUFFER_BYTES + "<html><head></head><body>".length + "</body></html>".length,
    );
    expect(response.body).not.toContain("stylesheet");
  });

  // The failure used to vanish into a bare `catch {}`, leaving an unstyled dev
  // server and no explanation anywhere.
  it("reports a discovery failure and still delivers the document", async () => {
    const { logger, server } = createServer({ failCssDiscovery: true });
    const response = createResponse();
    createDevCssInjectionMiddleware(server)(createRequest(), response.res, vi.fn());

    response.res.setHeader("content-type", "text/html");
    response.res.end("<html><head></head><body>hi</body></html>");
    await response.finished;

    expect(response.body).toBe("<html><head></head><body>hi</body></html>");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((logger.error.mock.calls[0] as [string])[0]).toContain("module runner is gone");
  });
});
