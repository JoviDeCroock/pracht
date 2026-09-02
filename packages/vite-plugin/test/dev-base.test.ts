import type { IncomingMessage, ServerResponse } from "node:http";
import { h } from "preact";
import { createServer as createViteServer } from "vite";
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
  const [frameworkServer, app, baseHelpers, devSsr] = await Promise.all([
    import("../../framework/src/server.ts"),
    import("../../framework/src/app.ts"),
    import("../../framework/src/base.ts"),
    import("../src/plugin-dev-ssr.ts"),
  ]);
  return {
    createOwnedDevEntryMiddleware: devSsr.createOwnedDevEntryMiddleware,
    createDevSSRMiddleware: devSsr.createDevSSRMiddleware,
    defineApp: app.defineApp,
    frameworkServer,
    resolveApp: app.resolveApp,
    route: app.route,
    withBase: baseHelpers.withBase,
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
  const headers = new Map<string, unknown>();
  const state = { body: "", statusCode: 0 };
  const res = {
    end(body?: unknown) {
      state.body = String(body ?? "");
      state.statusCode = res.statusCode;
    },
    getHeaderNames() {
      return [...headers.keys()];
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
    },
    statusCode: 200,
  };
  return { res: res as unknown as ServerResponse, state };
}

async function render(base: string, url: string) {
  const { createDevSSRMiddleware, defineApp, frameworkServer, resolveApp, route, withBase } =
    await loadDevServerModules(base);

  const serverMod = {
    apiRoutes: [],
    islandsBootstrapRequired: false,
    registry: {
      routeModules: {
        "./routes/about.tsx": async () => ({
          Component: () =>
            h(
              "main",
              null,
              h("img", { id: "based", src: withBase("/logo.svg") }),
              h("img", { id: "root", src: "/shared/logo.svg" }),
              h("img", { id: "spaced-root", src: " /shared/spaced.svg" }),
              h("img", {
                id: "srcset",
                srcSet: "/shared/one.svg 1x, /shared/two.svg 2x",
              }),
              h("img", {
                id: "spaced-srcset",
                srcSet: " /shared/three.svg 1x, /shared/four.svg 2x",
              }),
            ),
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

  // Exercise Vite's real HTML transform: it prefixes root-absolute asset
  // attributes with `base`, which is where double-base regressions arise.
  const transformServer = await createViteServer({
    appType: "custom",
    base,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const server = {
      config: { base, logger: { warn: vi.fn() }, root: "/tmp/pracht-dev-base-test" },
      ssrFixStacktrace: () => {},
      ssrLoadModule: async (id: string) => {
        if (id === "@pracht/core/server") return frameworkServer;
        if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
        throw new Error(`Unexpected ssrLoadModule id: ${id}`);
      },
      transformIndexHtml: transformServer.transformIndexHtml.bind(transformServer),
    } as unknown as ViteDevServer;

    const { res, state } = createResponse();
    // Vite hands the middleware a base-free URL.
    await createDevSSRMiddleware(server)(createRequest(url), res, vi.fn());
    return state;
  } finally {
    await transformServer.close();
  }
}

describe("dev SSR under a deploy base", () => {
  it("serves the client entry and hydration URL under the base", async () => {
    const state = await render("/app/", "/about?ref=campaign");

    expect(state.statusCode).toBe(200);
    expect(state.body).toContain('src="/app/@pracht/client.js"');
    expect(state.body).toContain('id="based" src="/app/logo.svg"');
    expect(state.body).toContain('id="root" src="/shared/logo.svg"');
    expect(state.body).toContain('id="spaced-root" src=" /shared/spaced.svg"');
    expect(state.body).toContain('id="srcset" srcset="/shared/one.svg 1x, /shared/two.svg 2x"');
    expect(state.body).toContain(
      'id="spaced-srcset" srcset=" /shared/three.svg 1x, /shared/four.svg 2x"',
    );
    expect(state.body).not.toContain("/app/shared/");
    expect(state.body).not.toContain("/app/app/");
    expect(state.body).toContain('"url":"/app/about?ref=campaign"');
  }, 15_000);

  it("is unchanged at the origin root", async () => {
    const state = await render("/", "/about?ref=campaign");

    expect(state.statusCode).toBe(200);
    expect(state.body).toContain('src="/@pracht/client.js"');
    expect(state.body).toContain('"url":"/about?ref=campaign"');
  });
});

describe("adapter-owned dev entries under a deploy base", () => {
  it.each(["/@pracht/client.js", "/@pracht/islands.js"])(
    "serves %s through Vite before the adapter runtime",
    async (entryPath) => {
      const { createOwnedDevEntryMiddleware } = await loadDevServerModules("/app/");
      const transformRequest = vi.fn(async () => ({
        code: "export const ready = true;",
        etag: 'W/"1"',
      }));
      const server = {
        config: { base: "/app/", server: { headers: { "x-dev": "pracht" } } },
        transformRequest,
      } as unknown as ViteDevServer;
      const middleware = createOwnedDevEntryMiddleware(server);
      const headers: Record<string, string> = {};
      let body = "";
      const response = {
        end(value?: unknown) {
          body = String(value ?? "");
        },
        setHeader(name: string, value: unknown) {
          headers[name.toLowerCase()] = String(value);
        },
        statusCode: 0,
      } as unknown as ServerResponse;
      const next = vi.fn();

      await middleware(
        {
          headers: {},
          method: "GET",
          url: `/app${entryPath}?t=1`,
        } as unknown as IncomingMessage,
        response,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(transformRequest).toHaveBeenCalledWith(`${entryPath}?t=1`);
      expect(response.statusCode).toBe(200);
      expect(headers).toMatchObject({
        "cache-control": "no-cache",
        "content-type": "text/javascript",
        etag: 'W/"1"',
        "x-dev": "pracht",
      });
      expect(body).toBe("export const ready = true;");
    },
  );

  it("does not expose base-free client entries", async () => {
    const { createOwnedDevEntryMiddleware } = await loadDevServerModules("/app/");
    const server = {
      config: { base: "/app/", server: { headers: {} } },
      transformRequest: vi.fn(),
    } as unknown as ViteDevServer;
    const next = vi.fn();

    await createOwnedDevEntryMiddleware(server)(
      { headers: {}, method: "GET", url: "/@pracht/client.js" } as unknown as IncomingMessage,
      {} as ServerResponse,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(server.transformRequest).not.toHaveBeenCalled();
  });
});
