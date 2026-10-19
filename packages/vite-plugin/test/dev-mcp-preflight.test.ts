import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import * as framework from "@pracht/core/server";

import { createDevMcpPreflightMiddleware, useBeforeViteCors } from "../src/plugin-dev-ssr.ts";

function setup(
  options: {
    allowedHosts?: string[] | true;
    base?: string;
    host?: string;
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
    config: {
      base: options.base ?? "/",
      server: { allowedHosts: options.allowedHosts, host: options.host },
    },
    ssrLoadModule: vi.fn(async (id: string) =>
      id === "@pracht/core/server" ? framework : serverMod,
    ),
  };
  const handler = vi.fn((_req: unknown, _res: unknown, _next: unknown): void => {});
  const middleware = createDevMcpPreflightMiddleware(server as never, handler as never);
  const run = (method: string, url: string, origin?: string, host = "localhost:5173") =>
    new Promise<{ handled: boolean; url: string }>((resolve) => {
      const req = { method, url, headers: { host, ...(origin ? { origin } : {}) } };
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

  it("checks Host the way Vite does before taking a request from in front of it", async () => {
    const origin = "https://inspector.example";
    const { run } = setup({ mcp, allowedHosts: [".dev.example"], host: "box.lan" });
    for (const host of [
      "127.0.0.1:5173",
      "[::1]:5173",
      "app.localhost",
      "box.lan",
      "a.dev.example",
    ]) {
      expect((await run("OPTIONS", "/mcp", origin, host)).handled).toBe(true);
    }
    expect((await run("OPTIONS", "/mcp", origin, "rebind.attacker.example")).handled).toBe(false);
    const open = setup({ mcp, allowedHosts: true });
    expect((await open.run("OPTIONS", "/mcp", origin, "anything.example")).handled).toBe(true);
  });
});

describe("useBeforeViteCors", () => {
  it("runs ahead of the CORS middleware a real Vite dev server registers first", async () => {
    const server = await createViteServer({
      configFile: false,
      logLevel: "silent",
      root: mkdtempSync(join(tmpdir(), "pracht-dev-cors-")),
      server: { middlewareMode: true, ws: false },
      plugins: [
        {
          name: "preflight-probe",
          configureServer(vite) {
            useBeforeViteCors(vite, (req, res, next) => {
              if (req.method !== "OPTIONS" || req.url !== "/api/own") return next();
              res.statusCode = 204;
              res.setHeader("x-own-options", "1");
              res.end();
            });
          },
        },
      ],
    });
    const http = createServer(server.middlewares);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    try {
      const preflight = (path: string) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: "OPTIONS",
          headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
        });
      expect((await preflight("/api/own")).headers.get("x-own-options")).toBe("1");
      // Every other preflight is still Vite's.
      const other = await preflight("/api/other");
      expect(other.status).toBe(204);
      expect(other.headers.get("x-own-options")).toBeNull();
    } finally {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      await server.close();
    }
  });
});
