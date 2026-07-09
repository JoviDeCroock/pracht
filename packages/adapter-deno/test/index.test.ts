import { describe, expect, it, vi } from "vitest";

import { defineApp, resolveApiRoutes, route } from "../../framework/src/index.ts";

import {
  createDenoRequestHandler,
  createDenoServerEntryModule,
  denoAdapter,
} from "../src/index.ts";

describe("createDenoServerEntryModule", () => {
  it("imports an app createContext module when configured", () => {
    const source = createDenoServerEntryModule({
      createContextFrom: "/src/server/context.ts",
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain("createContext: createPrachtContext");
  });

  it("starts with Deno.serve only when run directly", () => {
    const source = createDenoServerEntryModule({ port: 8787 });

    expect(source).toContain("if (import.meta.main)");
    expect(source).toContain('Number(Deno.env.get("PORT") ?? 8787)');
    expect(source).toContain("Deno.serve({ port }, handler)");
  });
});

describe("denoAdapter", () => {
  it("declares a Deno build target and edge-style bundling", () => {
    const adapter = denoAdapter();

    expect(adapter.id).toBe("deno");
    expect(adapter.edge).toBe(true);
    expect(adapter.serverImports).toContain("resolveApp");
    expect(adapter.createServerEntryModule()).toContain("createDenoRequestHandler");
  });
});

describe("createDenoRequestHandler", () => {
  it("passes Web requests directly to API routes", async () => {
    const handler = createDenoRequestHandler({
      apiRoutes: resolveApiRoutes(["/src/api/hello.ts"]),
      app: defineApp({ routes: [] }),
      registry: {
        apiModules: {
          "/src/api/hello.ts": async () => ({
            GET: ({ request }) =>
              new Response(`hello ${new URL(request.url).searchParams.get("name")}`),
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/api/hello?name=deno"));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("hello deno");
  });

  it("uses createContext for loader requests", async () => {
    const createContext = vi.fn(({ request }) => ({
      runtime: request.headers.get("x-runtime"),
    }));
    const handler = createDenoRequestHandler({
      app: defineApp({
        routes: [route("/runtime", "./routes/runtime.tsx", { render: "ssr" })],
      }),
      createContext,
      registry: {
        routeModules: {
          "./routes/runtime.tsx": async () => ({
            Component: ({ data }) => `<main>${(data as { runtime: string }).runtime}</main>`,
            loader: ({ context }) => ({
              runtime: (context as { runtime: string }).runtime,
            }),
          }),
        },
      },
    });

    const response = await handler(
      new Request("https://example.com/runtime", {
        headers: { "x-runtime": "deno" },
      }),
    );

    expect(createContext).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("deno");
  });
});
