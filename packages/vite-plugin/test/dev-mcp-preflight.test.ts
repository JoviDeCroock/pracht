import { describe, expect, it, vi } from "vitest";

import * as framework from "@pracht/core/server";

import { createDevMcpPreflightMiddleware } from "../src/plugin-dev-ssr.ts";

function setup(
  options: {
    base?: string;
    mcp?: Record<string, unknown>;
    apiModules?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const apiFiles = Object.keys(options.apiModules ?? {});
  const serverMod = {
    resolvedApp: { agents: { mcp: options.mcp } },
    apiRoutes: framework.resolveApiRoutes(apiFiles),
    registry: {
      apiModules: Object.fromEntries(
        Object.entries(options.apiModules ?? {}).map(([file, mod]) => [file, async () => mod]),
      ),
    },
  };
  const server = {
    config: { base: options.base ?? "/" },
    ssrLoadModule: vi.fn(async (id: string) =>
      id === "@pracht/core/server" ? framework : serverMod,
    ),
  };
  const handler = vi.fn((_req: unknown, _res: unknown, _next: unknown): void => {});
  const middleware = createDevMcpPreflightMiddleware(server as never, handler as never);
  const run = (method: string, url: string, origin?: string) =>
    new Promise<{ handled: boolean; url: string }>((resolve) => {
      const req = { method, url, headers: origin ? { origin } : {} };
      handler.mockImplementationOnce(() => resolve({ handled: true, url: req.url }));
      middleware(req as never, {} as never, () => resolve({ handled: false, url: req.url }));
    });
  return { run, server };
}

describe("createDevMcpPreflightMiddleware", () => {
  const mcp = { allowedOrigins: ["https://inspector.example"] };

  it("hands a listed origin's MCP preflight to pracht before Vite's CORS middleware", async () => {
    const { run } = setup({ mcp });
    expect(await run("OPTIONS", "/mcp", "https://inspector.example")).toEqual({
      handled: true,
      url: "/mcp",
    });
  });

  it("leaves every other request to Vite", async () => {
    const { run, server } = setup({ mcp });
    expect((await run("OPTIONS", "/mcp", "https://evil.example")).handled).toBe(false);
    expect((await run("OPTIONS", "/src/main.ts", "https://inspector.example")).handled).toBe(false);
    expect((await run("POST", "/mcp", "https://inspector.example")).handled).toBe(false);
    expect((await run("OPTIONS", "/mcp")).handled).toBe(false);
    // Vite's own paths never load the app.
    server.ssrLoadModule.mockClear();
    expect((await run("OPTIONS", "/@vite/client", "https://inspector.example")).handled).toBe(
      false,
    );
    expect(server.ssrLoadModule).not.toHaveBeenCalled();
    const unconfigured = setup({});
    expect((await unconfigured.run("OPTIONS", "/mcp", "https://inspector.example")).handled).toBe(
      false,
    );
  });

  it("strips the dev base the way Vite would", async () => {
    const { run } = setup({ base: "/app/", mcp });
    expect(await run("OPTIONS", "/app/mcp", "https://inspector.example")).toEqual({
      handled: true,
      url: "/mcp",
    });
    expect((await run("OPTIONS", "/mcp", "https://inspector.example")).handled).toBe(false);
  });

  it("leaves the URL of an unrelated preflight under the dev base for Vite", async () => {
    const { run } = setup({ base: "/app/", mcp });
    expect(await run("OPTIONS", "/app/api/upload", "https://inspector.example")).toEqual({
      handled: false,
      url: "/app/api/upload",
    });
  });

  it("hands OPTIONS to an API route that exports an OPTIONS handler, as production does", async () => {
    const OPTIONS = () => new Response(null, { status: 204 });
    const { run } = setup({
      base: "/app/",
      apiModules: {
        "/src/api/upload.ts": { OPTIONS, POST: () => new Response("ok") },
        "/src/api/plain.ts": { POST: () => new Response("ok") },
        "/src/api/any.ts": { default: () => new Response("ok") },
      },
    });
    expect(await run("OPTIONS", "/app/api/upload", "https://other.example")).toEqual({
      handled: true,
      url: "/api/upload",
    });
    // Without an Origin as well: the export answers every OPTIONS request.
    expect((await run("OPTIONS", "/app/api/upload")).handled).toBe(true);
    // No OPTIONS export, or only a catch-all `default`: Vite answers as before.
    expect((await run("OPTIONS", "/app/api/plain", "https://other.example")).handled).toBe(false);
    expect((await run("OPTIONS", "/app/api/any", "https://other.example")).handled).toBe(false);
    expect((await run("OPTIONS", "/app/api/nope", "https://other.example")).handled).toBe(false);
  });
});
