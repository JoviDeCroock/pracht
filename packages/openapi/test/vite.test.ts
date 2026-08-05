import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { prachtOpenApi, resolvePrachtOpenApiOptions } from "../src/vite.ts";

function hookHandler<T extends (...args: any[]) => any>(hook: T | { handler: T } | undefined): T {
  if (!hook) throw new Error("Expected Vite hook");
  return typeof hook === "function" ? hook : hook.handler;
}

describe("prachtOpenApi options", () => {
  it("defaults to JSON-only endpoints", () => {
    expect(resolvePrachtOpenApiOptions({ info: { title: "Example", version: "1.0.0" } })).toEqual({
      document: {},
      documentPath: "/openapi.json",
      failOnWarnings: false,
      info: { title: "Example", version: "1.0.0" },
      ui: null,
    });
  });

  it("normalizes shorthand UI options", () => {
    expect(
      resolvePrachtOpenApiOptions({
        documentPath: "/schema.json/",
        info: { title: "Example", version: "1.0.0" },
        ui: "scalar",
      }),
    ).toMatchObject({
      documentPath: "/schema.json",
      ui: { path: "/docs", provider: "scalar" },
    });
  });

  it("rejects unsafe and colliding paths", () => {
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/../openapi.json",
        info: { title: "Example", version: "1.0.0" },
      }),
    ).toThrow(/safe root-relative/);
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/%2e%2e/openapi.json",
        info: { title: "Example", version: "1.0.0" },
      }),
    ).toThrow(/safe root-relative/);
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/openapi.json\n",
        info: { title: "Example", version: "1.0.0" },
      }),
    ).toThrow(/safe root-relative/);
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/openapi",
        info: { title: "Example", version: "1.0.0" },
      }),
    ).toThrow(/must end in \.json/);
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/docs.json",
        info: { title: "Example", version: "1.0.0" },
        ui: { path: "/docs.json", provider: "swagger" },
      }),
    ).toThrow(/must be different/);
  });
});

describe("prachtOpenApi Vite integration", () => {
  it("augments only the Pracht server module with an artifact generator", async () => {
    const plugin = prachtOpenApi({
      info: { title: "Example", version: "1.0.0" },
      ui: { provider: "swagger", path: "/reference" },
    });
    const transform = hookHandler(plugin.transform);
    const context = {} as never;
    const source = "const apiModules = {}; const apiRoutes = [];";

    const result = await transform.call(context, source, "\0virtual:pracht/server");
    const code = typeof result === "string" ? result : result?.code;
    expect(code).toContain('from "@pracht/openapi"');
    expect(code).toContain("export async function generatePrachtOpenApiArtifacts()");
    expect(code).toContain('"path":"/reference"');
    const devResult = await transform.call(context, source, "\0virtual:pracht/dev-metadata");
    const devCode = typeof devResult === "string" ? devResult : devResult?.code;
    expect(devCode).toContain("generatePrachtOpenApiArtifacts");
    expect(await transform.call(context, source, "/src/app.ts")).toBeNull();
  });

  it("serves generated JSON, UI, HEAD, and method errors in dev", async () => {
    const artifacts = {
      artifacts: [
        {
          content: '{"openapi":"3.1.0"}\n',
          contentType: "application/json; charset=utf-8",
          outputPath: "openapi.json",
          path: "/openapi.json",
        },
        {
          content: "<!doctype html><title>Docs</title>",
          contentType: "text/html; charset=utf-8",
          outputPath: "docs/index.html",
          path: "/docs",
        },
      ],
      warnings: [
        {
          code: "undocumented_response",
          file: "/src/api/health.ts",
          message: "Missing response metadata.",
          method: "GET",
          path: "/api/health",
        },
      ],
    };
    let middleware: Connect.NextHandleFunction | undefined;
    const warn = vi.fn();
    const server = {
      config: { logger: { error: vi.fn(), warn } },
      middlewares: { use: (handler: Connect.NextHandleFunction) => (middleware = handler) },
      ssrFixStacktrace: vi.fn(),
      ssrLoadModule: vi.fn(async (id: string) =>
        id === "@pracht/core/server"
          ? { matchApiRoute: () => undefined, matchAppRoute: () => undefined }
          : { generatePrachtOpenApiArtifacts: async () => artifacts },
      ),
    } as unknown as ViteDevServer;
    const plugin = prachtOpenApi({
      info: { title: "Example", version: "1.0.0" },
      ui: "scalar",
    });
    hookHandler(plugin.configureServer).call({} as never, server);
    if (!middleware) throw new Error("Expected middleware registration");

    const json = await runMiddleware(middleware, "/openapi.json", "GET");
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    expect(json.body).toContain('"openapi"');

    const ui = await runMiddleware(middleware, "/docs/", "GET");
    expect(ui.status).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");

    const head = await runMiddleware(middleware, "/openapi.json", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    const post = await runMiddleware(middleware, "/openapi.json", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(server.ssrLoadModule).toHaveBeenCalledWith("virtual:pracht/dev-metadata");
  });
});

async function runMiddleware(
  middleware: Connect.NextHandleFunction,
  url: string,
  method: string,
): Promise<{ body: string; headers: Record<string, string>; status: number }> {
  const request = { method, url } as IncomingMessage;
  const headers: Record<string, string> = {};
  let body = "";
  const response = {
    end(value?: unknown) {
      body = value === undefined ? "" : String(value);
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
    },
    statusCode: 200,
  } as unknown as ServerResponse;
  await middleware(request, response, vi.fn());
  return { body, headers, status: response.statusCode };
}
