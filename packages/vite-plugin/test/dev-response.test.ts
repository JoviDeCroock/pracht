import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import * as frameworkServer from "../../framework/src/server.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../../framework/src/app.ts";
import { createDevSSRMiddleware, writeDevResponseHeaders } from "../src/plugin-dev-ssr.ts";
import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";

/**
 * The dev middleware writes into a real `ServerResponse`, which is a writable
 * stream with append-aware `setHeader` semantics for `set-cookie`. Model both:
 * a plain object fake would hide exactly the defects under test.
 */
function createResponse() {
  const headers: Record<string, string | string[]> = {};
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  // `end` for a clean response, `close` for one destroyed mid-stream.
  const finished = new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  });
  const res = Object.assign(stream, {
    getHeader: (name: string) => headers[name.toLowerCase()],
    getHeaderNames: () => Object.keys(headers),
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
      return res;
    },
    statusCode: 200,
  }) as unknown as ServerResponse;

  return {
    finished,
    headers,
    res,
    get bytes() {
      return Buffer.concat(chunks);
    },
  };
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0xfd,
]);

async function request(
  options: {
    apiResponse?: () => Response;
    loaderCookies?: string[];
    url?: string;
  } = {},
) {
  const serverMod = {
    apiRoutes: resolveApiRoutes(["/src/api/download.ts"]),
    islandsBootstrapRequired: false,
    registry: {
      apiModules: {
        "/src/api/download.ts": async () => ({
          GET: () =>
            options.apiResponse?.() ??
            new Response("ok", { headers: { "content-type": "text/plain" } }),
        }),
      },
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => null,
          loader: () => {
            const headers = new Headers();
            for (const cookie of options.loaderCookies ?? []) headers.append("set-cookie", cookie);
            return new Response(null, { headers, status: 204 });
          },
        }),
      },
    },
    resolvedApp: resolveApp(
      defineApp({
        routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssr" })],
      }),
    ),
  };

  const logger = { error: vi.fn(), warn: vi.fn() };
  const server = {
    config: { base: "/", logger, root: "/tmp/pracht-dev-res" },
    ssrFixStacktrace: () => {},
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;

  const response = createResponse();
  const req = {
    headers: { accept: "*/*", host: "localhost" },
    method: "GET",
    url: options.url ?? "/api/download",
  } as unknown as IncomingMessage;

  await createDevSSRMiddleware(server)(req, response.res, vi.fn());
  await response.finished;
  return { ...response, logger };
}

describe("writeDevResponseHeaders", () => {
  // `headers.forEach()` yields set-cookie once, comma-joined, and `setHeader`
  // replaces instead of appending — so the old copy loop emitted one broken
  // cookie where production emitted two.
  it("keeps every Set-Cookie separate", () => {
    const setHeader = vi.fn();
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "session=1; Path=/; HttpOnly");
    headers.append("set-cookie", "theme=dark; Path=/");

    writeDevResponseHeaders({ setHeader } as unknown as ServerResponse, headers);

    expect(setHeader).toHaveBeenCalledWith("set-cookie", [
      "session=1; Path=/; HttpOnly",
      "theme=dark; Path=/",
    ]);
    expect(setHeader).toHaveBeenCalledWith("content-type", "text/plain");
    expect(setHeader).toHaveBeenCalledTimes(2);
  });

  it("leaves a response without cookies untouched", () => {
    const setHeader = vi.fn();
    writeDevResponseHeaders(
      { setHeader } as unknown as ServerResponse,
      new Headers({ "cache-control": "no-store" }),
    );
    expect(setHeader).toHaveBeenCalledWith("cache-control", "no-store");
    expect(setHeader).toHaveBeenCalledTimes(1);
  });
});

describe("dev SSR response body", () => {
  it("forwards a binary API body byte for byte", async () => {
    const response = await request({
      apiResponse: () =>
        new Response(new Uint8Array(PNG_BYTES), {
          headers: { "content-type": "image/png" },
        }),
    });

    expect(response.headers["content-type"]).toBe("image/png");
    // Decoding through `response.text()` replaced 0xff/0xfe/0xfd with U+FFFD.
    expect(response.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("emits both cookies an API route sets", async () => {
    const response = await request({
      apiResponse: () => {
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", "session=1; Path=/; HttpOnly");
        headers.append("set-cookie", "theme=dark; Path=/");
        return new Response("ok", { headers });
      },
    });

    expect(response.headers["set-cookie"]).toEqual([
      "session=1; Path=/; HttpOnly",
      "theme=dark; Path=/",
    ]);
  });

  it("emits both cookies a page loader sets", async () => {
    const response = await request({
      loaderCookies: ["session=1; Path=/; HttpOnly", "theme=dark; Path=/"],
      url: "/",
    });

    expect(response.headers["set-cookie"]).toEqual([
      "session=1; Path=/; HttpOnly",
      "theme=dark; Path=/",
    ]);
  });

  // The response is already on the wire when the body fails, so it can never
  // become a 500. Destroying the socket silently left the developer with a
  // truncated download and no explanation anywhere.
  it("logs a body stream that fails mid-response", async () => {
    const response = await request({
      apiResponse: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.error(new Error("body stream exploded"));
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    });

    expect(response.logger.error).toHaveBeenCalledTimes(1);
    expect((response.logger.error.mock.calls[0] as [string])[0]).toContain("body stream exploded");
    expect((response.logger.error.mock.calls[0] as [string])[0]).toContain("/api/download");
  });

  it("answers a bodiless response without hanging", async () => {
    const response = await request({
      apiResponse: () => new Response(null, { status: 204 }),
    });

    expect(response.res.statusCode).toBe(204);
    expect(response.bytes.length).toBe(0);
  });
});
