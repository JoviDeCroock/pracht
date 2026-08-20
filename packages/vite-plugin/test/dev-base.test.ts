import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";

/**
 * Vite's own base middleware strips the base from `req.url` before this
 * handler runs, so the dev server sees base-free paths — but the document it
 * writes back has to carry the base, exactly like a production build. Without
 * that, the client entry 404s behind the base middleware (dev never hydrates)
 * and the serialized hydration URL disagrees with `window.location`.
 *
 * Vite defines `import.meta.env.BASE_URL` across the dev SSR module graph, so
 * the modules are re-imported with it stubbed.
 */
async function loadDevServerModules(base: string) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", base);
  const [frameworkServer, app, devSsr] = await Promise.all([
    import("../../framework/src/server.ts"),
    import("../../framework/src/app.ts"),
    import("../src/plugin-dev-ssr.ts"),
  ]);
  return {
    createDevSSRMiddleware: devSsr.createDevSSRMiddleware,
    defineApp: app.defineApp,
    frameworkServer,
    resolveApp: app.resolveApp,
    route: app.route,
  };
}

function createRequest(url: string): IncomingMessage {
  return {
    headers: { accept: "text/html,application/xhtml+xml", host: "localhost" },
    method: "GET",
    url,
  } as unknown as IncomingMessage;
}

function createResponse() {
  const state = { body: "", statusCode: 0 };
  const res = {
    end(body?: unknown) {
      state.body = String(body ?? "");
      state.statusCode = res.statusCode;
    },
    setHeader() {},
    statusCode: 200,
  };
  return { res: res as unknown as ServerResponse, state };
}

async function render(base: string, url: string) {
  const { createDevSSRMiddleware, defineApp, frameworkServer, resolveApp, route } =
    await loadDevServerModules(base);

  const serverMod = {
    apiRoutes: [],
    islandsBootstrapRequired: false,
    registry: {
      routeModules: {
        "./routes/about.tsx": async () => ({
          Component: () => null,
          loader: async () => ({ ok: true }),
        }),
      },
    },
    resolvedApp: resolveApp(
      defineApp({
        routes: [route("/about", "./routes/about.tsx", { id: "about", render: "ssr" })],
      }),
    ),
  };

  const server = {
    config: { base, logger: { warn: vi.fn() }, root: "/tmp/pracht-dev-base-test" },
    ssrFixStacktrace: () => {},
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;

  const { res, state } = createResponse();
  // Vite hands the middleware a base-free URL.
  await createDevSSRMiddleware(server)(createRequest(url), res, vi.fn());
  return state;
}

describe("dev SSR under a deploy base", () => {
  it("serves the client entry and hydration URL under the base", async () => {
    const state = await render("/app/", "/about?ref=campaign");

    expect(state.statusCode).toBe(200);
    expect(state.body).toContain('src="/app/@pracht/client.js"');
    expect(state.body).toContain('"url":"/app/about?ref=campaign"');
  });

  it("is unchanged at the origin root", async () => {
    const state = await render("/", "/about?ref=campaign");

    expect(state.statusCode).toBe(200);
    expect(state.body).toContain('src="/@pracht/client.js"');
    expect(state.body).toContain('"url":"/about?ref=campaign"');
  });
});
