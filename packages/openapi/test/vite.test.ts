import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import {
  prachtOpenApi,
  resolvePrachtOpenApiOptions,
  type PrachtOpenApiArtifacts,
} from "../src/vite.ts";

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

  it("canonicalizes endpoint paths for browser requests and static output", () => {
    expect(
      resolvePrachtOpenApiOptions({
        documentPath: "/schéma//openapi.json",
        info: { title: "Example", version: "1.0.0" },
        ui: { path: "/référence", provider: "scalar" },
      }),
    ).toMatchObject({
      documentPath: "/sch%C3%A9ma/openapi.json",
      ui: { path: "/r%C3%A9f%C3%A9rence", provider: "scalar" },
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
    ).toThrow(/must not overlap/);
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/docs/index.html/openapi.json",
        info: { title: "Example", version: "1.0.0" },
        ui: "scalar",
      }),
    ).toThrow(/must not overlap/);
    expect(() =>
      resolvePrachtOpenApiOptions({
        documentPath: "/docs/openapi.json",
        info: { title: "Example", version: "1.0.0" },
        ui: { path: "/docs/openapi.json/reference", provider: "scalar" },
      }),
    ).toThrow(/must not overlap/);
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

  it("serves the document and default API server under the Vite deploy base", async () => {
    const plugin = prachtOpenApi({
      info: { title: "Example", version: "1.0.0" },
      ui: "scalar",
    });
    hookHandler(plugin.configResolved).call({} as never, { base: "/app/" } as never);
    const transform = hookHandler(plugin.transform);
    const result = await transform.call(
      {} as never,
      "const apiModules = {}; const apiRoutes = [];",
      "\0virtual:pracht/server",
    );
    const transformedCode = typeof result === "string" ? result : result?.code;
    if (!transformedCode) throw new Error("Expected generated OpenAPI source");
    const code = String(transformedCode);

    const standalone = code.replace(
      'import { createOpenApiUiHtml as __prachtCreateOpenApiUiHtml, generateOpenApiDocument as __prachtGenerateOpenApiDocument } from "@pracht/openapi";',
      `const __prachtCreateOpenApiUiHtml = (options) => JSON.stringify(options);
const __prachtGenerateOpenApiDocument = async (options) => ({
  document: { openapi: "3.1.0", ...(options.document.servers ? { servers: options.document.servers } : {}) },
  warnings: [],
});`,
    );
    const generated = (await import(
      `data:text/javascript;base64,${Buffer.from(standalone).toString("base64")}#${Date.now()}`
    )) as { generatePrachtOpenApiArtifacts: () => Promise<PrachtOpenApiArtifacts> };
    const artifacts = await generated.generatePrachtOpenApiArtifacts();
    const document = JSON.parse(
      artifacts.artifacts.find((artifact) => artifact.path === "/openapi.json")!.content,
    );
    const ui = JSON.parse(
      artifacts.artifacts.find((artifact) => artifact.path === "/docs")!.content,
    );

    expect(document.servers).toEqual([{ url: "/app" }]);
    expect(ui.documentUrl).toBe("/app/openapi.json");
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

  it("serves development artifacts only under the Vite deploy base", async () => {
    const artifacts = {
      artifacts: [
        {
          content: '{"openapi":"3.1.0"}\n',
          contentType: "application/json; charset=utf-8",
          outputPath: "openapi.json",
          path: "/openapi.json",
        },
      ],
      warnings: [],
    };
    let middleware: Connect.NextHandleFunction | undefined;
    const server = {
      config: { logger: { error: vi.fn(), warn: vi.fn() } },
      middlewares: { use: (handler: Connect.NextHandleFunction) => (middleware = handler) },
      ssrFixStacktrace: vi.fn(),
      ssrLoadModule: vi.fn(async (id: string) =>
        id === "@pracht/core/server"
          ? { matchApiRoute: () => undefined, matchAppRoute: () => undefined }
          : { generatePrachtOpenApiArtifacts: async () => artifacts },
      ),
    } as unknown as ViteDevServer;
    const plugin = prachtOpenApi({ info: { title: "Example", version: "1.0.0" } });
    expect(plugin.configureServer).toMatchObject({ order: "pre" });
    hookHandler(plugin.configResolved).call({} as never, { base: "/app/" } as never);
    hookHandler(plugin.configureServer).call({} as never, server);
    if (!middleware) throw new Error("Expected middleware registration");

    const underBase = await runMiddleware(middleware, "/app/openapi.json", "GET");
    expect(underBase.status).toBe(200);
    expect(underBase.body).toContain('"openapi"');

    const next = vi.fn();
    await runMiddleware(middleware, "/openapi.json", "GET", next);
    expect(next).toHaveBeenCalledOnce();
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(2);
  });
});

async function runMiddleware(
  middleware: Connect.NextHandleFunction,
  url: string,
  method: string,
  next = vi.fn(),
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
  await middleware(request, response, next);
  return { body, headers, status: response.statusCode };
}
