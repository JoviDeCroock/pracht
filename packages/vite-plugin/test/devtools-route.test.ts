import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import * as devtoolsModule from "../../framework/src/devtools.ts";
import * as frameworkServer from "../../framework/src/server.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../../framework/src/app.ts";
import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";
import {
  createDevLlmsTxtMiddleware,
  createDevSSRMiddleware,
  DEVTOOLS_JSON_PATH,
  DEVTOOLS_PATH,
} from "../src/plugin-dev-ssr.ts";

function createServerMod(overrides: { routes?: ReturnType<typeof route>[] } = {}) {
  const app = defineApp({
    middleware: { auth: "./middleware/auth.ts" },
    routes: overrides.routes ?? [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr", shell: "public" }),
      route("/users/:id", "./routes/user.tsx", { middleware: ["auth"] }),
    ],
    shells: { public: "./shells/public.tsx" },
  });

  return {
    apiRoutes: resolveApiRoutes(["/src/api/health.ts"]),
    registry: {
      middlewareModules: {
        "./middleware/auth.ts": async () => ({
          middleware: async (_args: unknown, next: () => Promise<Response>) => next(),
        }),
      },
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => null,
          loader: async () => ({ ok: true }),
        }),
      },
      shellModules: {
        "./shells/public.tsx": async () => ({}),
      },
    },
    resolvedApp: resolveApp(app),
  };
}

function createStubServer(
  serverMod: ReturnType<typeof createServerMod>,
  options: { publicDir?: string } = {},
) {
  const warn = vi.fn();
  const server = {
    config: {
      logger: { warn },
      publicDir: options.publicDir ?? "/tmp/pracht-devtools-test/public",
      root: "/tmp/pracht-devtools-test",
    },
    ssrFixStacktrace: () => {},
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === "@pracht/core/devtools") return devtoolsModule;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      if (id === "/src/api/health.ts") return { GET: async () => Response.json({ ok: true }) };
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;

  return { server, warn };
}

function createRequest(url: string): IncomingMessage {
  return {
    headers: { accept: "text/html,application/xhtml+xml", host: "localhost" },
    method: "GET",
    url,
  } as unknown as IncomingMessage;
}

function createResponse() {
  const headers: Record<string, string> = {};
  const state = { body: "", ended: false, statusCode: 0 };
  const res = {
    end(body?: unknown) {
      state.body = String(body ?? "");
      state.ended = true;
      state.statusCode = res.statusCode;
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
    },
    statusCode: 200,
  };

  return { headers, res: res as unknown as ServerResponse, state };
}

async function runMiddleware(server: ViteDevServer, url: string) {
  const middleware = createDevSSRMiddleware(server);
  const req = createRequest(url);
  const { headers, res, state } = createResponse();
  const next = vi.fn();
  await middleware(req, res, next);
  return { headers, next, state };
}

describe("dev middleware generated llms.txt artifacts", () => {
  it("serves generated Markdown ahead of a colliding public file and warns once", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-llms-dev-"));
    const publicDir = join(root, "public");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, "about.md"), "# Public\n", "utf-8");

    try {
      const serverMod = {
        ...createServerMod(),
        generateLlmsTxtArtifacts: async () => [
          { outputPath: "llms.txt", content: "# App\n" },
          { outputPath: "about.md", content: "# Generated\n" },
        ],
      };
      const { server, warn } = createStubServer(serverMod, { publicDir });
      const middleware = createDevLlmsTxtMiddleware(server);

      for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
        const response = createResponse();
        const next = vi.fn();
        await middleware(createRequest("/about.md"), response.res, next);

        expect(next).not.toHaveBeenCalled();
        expect(response.state.body).toBe("# Generated\n");
        expect(response.headers["content-type"]).toContain("text/markdown");
      }

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("public/about.md");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("dev middleware /_pracht devtools route", () => {
  it("serves the self-contained devtools HTML page", async () => {
    const serverMod = createServerMod();
    const { server, warn } = createStubServer(serverMod);

    const { headers, next, state } = await runMiddleware(server, DEVTOOLS_PATH);

    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(200);
    expect(headers["content-type"]).toContain("text/html");
    expect(state.body).toContain("<!DOCTYPE html>");
    expect(state.body).toContain("pracht");
    expect(state.body).toContain("/users/:id");
    expect(state.body).toContain("auth");
    expect(state.body).toContain("./routes/user.tsx");
    expect(state.body).toContain("/api/health");
    expect(warn).not.toHaveBeenCalled();
  });

  it("serves the app graph as JSON at /_pracht.json", async () => {
    const serverMod = createServerMod();
    const { server } = createStubServer(serverMod);

    const { headers, state } = await runMiddleware(server, DEVTOOLS_JSON_PATH);

    expect(state.statusCode).toBe(200);
    expect(headers["content-type"]).toContain("application/json");

    const graph = JSON.parse(state.body) as devtoolsModule.AppGraph;
    expect(graph.routes).toEqual([
      {
        file: "./routes/home.tsx",
        hydration: null,
        id: "home",
        loaderCache: null,
        loaderFile: null,
        middleware: [],
        path: "/",
        prefetch: null,
        render: "ssr",
        revalidate: null,
        shell: "public",
        shellFile: "./shells/public.tsx",
        speculation: null,
      },
      {
        file: "./routes/user.tsx",
        hydration: null,
        id: expect.any(String),
        loaderCache: null,
        loaderFile: null,
        middleware: ["auth"],
        path: "/users/:id",
        prefetch: null,
        render: null,
        revalidate: null,
        shell: null,
        shellFile: null,
        speculation: null,
      },
    ]);
    expect(graph.api).toEqual([
      {
        file: "/src/api/health.ts",
        hasDefaultHandler: false,
        methods: ["GET"],
        path: "/api/health",
      },
    ]);
  });

  it("warns once and lets devtools win when an app route collides in dev", async () => {
    const serverMod = createServerMod({
      routes: [route("/_pracht", "./routes/collide.tsx", { id: "collide" })],
    });
    const { server, warn } = createStubServer(serverMod);
    const middleware = createDevSSRMiddleware(server);

    const first = createResponse();
    await middleware(createRequest(DEVTOOLS_PATH), first.res, vi.fn());
    expect(first.state.body).toContain("<!DOCTYPE html>");
    expect(first.state.body).toContain("devtools");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(DEVTOOLS_PATH);

    const second = createResponse();
    await middleware(createRequest(DEVTOOLS_PATH), second.res, vi.fn());
    expect(second.state.body).toContain("devtools");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("dev middleware Server-Timing header", () => {
  it("emits phase durations on SSR page responses", async () => {
    const serverMod = createServerMod();
    const { server } = createStubServer(serverMod);

    const { headers, state } = await runMiddleware(server, "/");

    expect(state.statusCode).toBe(200);
    expect(headers["content-type"]).toContain("text/html");
    expect(headers["server-timing"]).toMatch(
      /^mw;dur=\d+(\.\d+)?, loader;dur=\d+(\.\d+)?, render;dur=\d+(\.\d+)?$/,
    );
  });
});
