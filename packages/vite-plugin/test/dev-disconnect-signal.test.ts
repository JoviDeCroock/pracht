import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import * as frameworkServer from "../../framework/src/server.ts";
import { defineApp, resolveApiRoutes, resolveApp } from "../../framework/src/app.ts";
import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";
import { createDevSSRMiddleware } from "../src/plugin-dev-ssr.ts";

type ApiHandler = (args: { request: Request; signal: AbortSignal }) => Promise<Response>;

/** A real `node:http` server running the dev SSR middleware with one API route. */
async function listenDev(
  post: ApiHandler,
  options: { maxBodySize?: number } = {},
): Promise<{ port: number; close: () => void }> {
  const serverMod = {
    apiRoutes: resolveApiRoutes(["/src/api/work.ts"]),
    islandsBootstrapRequired: false,
    registry: {
      apiModules: { "/src/api/work.ts": async () => ({ POST: post }) },
      routeModules: {},
    },
    resolvedApp: resolveApp(defineApp({ routes: [] })),
  };
  const vite = {
    config: { base: "/", logger: { error: vi.fn(), warn: vi.fn() }, root: "/tmp/pracht-dev" },
    ssrFixStacktrace: () => {},
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;
  const middleware = createDevSSRMiddleware(vite, options);
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("dev client disconnect", () => {
  it("aborts the API handler's signal when the client hangs up", async () => {
    let resolveAborted!: (value: boolean) => void;
    const aborted = new Promise<boolean>((resolve) => (resolveAborted = resolve));
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const server = await listenDev(
      ({ signal }) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolveAborted(false), 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolveAborted(true);
            resolve(new Response("gone"));
          });
          resolveReady();
        }),
    );
    try {
      const client = httpRequest({
        host: "127.0.0.1",
        method: "POST",
        path: "/api/work",
        port: server.port,
      });
      client.on("error", () => {});
      client.end("{}");
      await ready;
      client.destroy();
      expect(await aborted).toBe(true);
    } finally {
      server.close();
    }
  });

  it("keeps the signal live after the upload is read while the handler works", async () => {
    let observed: boolean | undefined;
    const server = await listenDev(async ({ request, signal }) => {
      await request.text();
      await new Promise((resolve) => setTimeout(resolve, 20));
      observed = signal.aborted;
      return new Response("ok");
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/work`, {
        body: "{}",
        method: "POST",
      });
      expect(await response.text()).toBe("ok");
      expect(observed).toBe(false);
    } finally {
      server.close();
    }
  });

  it("answers an oversized body with the Node adapter's 413", async () => {
    const post = vi.fn<ApiHandler>(async () => new Response("never"));
    const server = await listenDev(post, { maxBodySize: 8 });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/work`, {
        body: "x".repeat(64),
        method: "POST",
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("Payload Too Large");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(post).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
