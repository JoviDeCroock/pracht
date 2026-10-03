import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { nodeAdapter } from "../../adapter-node/src/index.ts";
import { netlifyAdapter } from "../../adapter-netlify/src/index.ts";
import { vercelAdapter } from "../../adapter-vercel/src/index.ts";
import * as frameworkServer from "../../framework/src/server.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../../framework/src/app.ts";
import type { PrachtAdapterDevOptions } from "../src/plugin-adapter.ts";
import { createDevSSRMiddleware } from "../src/plugin-dev-ssr.ts";
import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";

/**
 * `pracht dev` serves requests itself for every adapter that does not own the
 * dev server, so it has to call the adapter's `createContextFrom` factory the
 * way the generated production entry does. It used to call none, and every
 * `context.db` loader worked in production and failed in dev only.
 */
async function request(adapterDev: PrachtAdapterDevOptions | undefined, url = "/api/context") {
  const createContext = vi.fn((args: Record<string, unknown>) => ({
    db: "pool",
    requestId: (args.request as Request).headers.get("x-request-id"),
  }));
  const serverMod = {
    apiRoutes: resolveApiRoutes(["/src/api/context.ts"]),
    islandsBootstrapRequired: false,
    registry: {
      apiModules: {
        "/src/api/context.ts": async () => ({
          GET: ({ context }: { context: unknown }) => Response.json({ context: context ?? null }),
        }),
      },
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => null,
          loader: ({ context }: { context: { requestId?: string } }) => ({
            requestId: context?.requestId,
          }),
        }),
      },
    },
    resolvedApp: resolveApp(
      defineApp({ routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssr" })] }),
    ),
  };

  const loaded: string[] = [];
  const server = {
    config: { base: "/", logger: { error: vi.fn(), warn: vi.fn() }, root: "/tmp/pracht-ctx" },
    ssrFixStacktrace: () => {},
    ssrLoadModule: async (id: string) => {
      loaded.push(id);
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      if (id === "/src/server/context.ts") return { createContext };
      if (id === "/src/server/no-export.ts") return { somethingElse: true };
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;

  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  });
  const res = Object.assign(stream, {
    getHeader: () => undefined,
    getHeaderNames: () => [],
    removeHeader: () => {},
    setHeader: () => res,
    statusCode: 200,
  }) as unknown as ServerResponse;
  const req = {
    headers: { accept: "*/*", host: "localhost", "x-request-id": "req-42" },
    method: "GET",
    url,
  } as unknown as IncomingMessage;

  const waitUntil = vi.fn();
  const next = vi.fn();
  await createDevSSRMiddleware(server, { adapterDev, waitUntil })(req, res, next);
  // A failure is handed to Vite's error middleware and never ends `res` here.
  if (next.mock.calls.length === 0) await finished;
  return {
    body: Buffer.concat(chunks).toString("utf-8"),
    createContext,
    loaded,
    next,
    req,
    res,
    status: res.statusCode,
    waitUntil,
  };
}

describe("dev SSR app context", () => {
  it("passes the Node adapter's context to API routes and loaders", async () => {
    const adapter = nodeAdapter({ createContextFrom: "/src/server/context.ts" });

    const api = await request(adapter.dev);
    expect(JSON.parse(api.body)).toEqual({ context: { db: "pool", requestId: "req-42" } });
    const [args] = api.createContext.mock.calls[0]!;
    expect(Object.keys(args).sort()).toEqual(["req", "request", "res"]);
    expect(args.req).toBe(api.req);
    expect(args.res).toBe(api.res);
    expect(args.request).toBeInstanceOf(Request);

    const page = await request(adapter.dev, "/?_data=1");
    expect(page.body).toContain('"requestId":"req-42"');
  });

  it.each([
    ["Vercel", vercelAdapter({ createContextFrom: "/src/server/context.ts" })],
    ["Netlify", netlifyAdapter({ createContextFrom: "/src/server/context.ts" })],
  ])("hands the %s factory { request, context } with a working waitUntil", async (_, adapter) => {
    const api = await request(adapter.dev);
    expect(JSON.parse(api.body).context.requestId).toBe("req-42");
    const [args] = api.createContext.mock.calls[0]!;
    expect(Object.keys(args).sort()).toEqual(["context", "request"]);
    const work = Promise.resolve();
    (args.context as { waitUntil(p: Promise<unknown>): void }).waitUntil(work);
    expect(api.waitUntil).toHaveBeenCalledWith(work);
  });

  it("calls nothing when the adapter has no context module", async () => {
    const api = await request(nodeAdapter().dev);
    expect(JSON.parse(api.body)).toEqual({ context: {} });
    expect(api.loaded).not.toContain("/src/server/context.ts");
    expect((await request(undefined)).createContext).not.toHaveBeenCalled();
  });

  it("fails loudly when the module does not export createContext", async () => {
    const api = await request({ createContextFrom: "/src/server/no-export.ts" });
    expect(api.next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("must export a createContext(args) function"),
      }),
    );
  });
});
