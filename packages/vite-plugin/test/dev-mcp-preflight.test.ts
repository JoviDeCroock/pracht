import { describe, expect, it, vi } from "vitest";

import { createDevMcpPreflightMiddleware } from "../src/plugin-dev-ssr.ts";

function setup(options: { base?: string; mcp?: Record<string, unknown> } = {}) {
  const server = {
    config: { base: options.base ?? "/" },
    ssrLoadModule: vi.fn(async () => ({ resolvedApp: { agents: { mcp: options.mcp } } })),
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
    // Only preflights with an Origin load the app at all.
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(2);
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
});
