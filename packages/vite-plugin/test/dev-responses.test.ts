import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { handleDevError, serveDevNotFound } from "../src/plugin-dev-responses.ts";

function createResponse() {
  const headers: Record<string, string> = {};
  const state = { body: "", statusCode: 0 };
  const response = {
    end(body?: unknown) {
      state.body = String(body ?? "");
      state.statusCode = response.statusCode;
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
    },
    statusCode: 200,
  };
  return { headers, response: response as unknown as ServerResponse, state };
}

describe("development response rendering", () => {
  it("keeps route-state failures as structured JSON", async () => {
    const server = { ssrFixStacktrace: vi.fn() } as unknown as ViteDevServer;
    const request = {
      headers: { "x-pracht-route-state-request": "1" },
    } as unknown as IncomingMessage;
    const { headers, response, state } = createResponse();
    const next = vi.fn();

    await handleDevError(server, request, response, next, "/dashboard?_data=1", new Error("boom"));

    expect(state.statusCode).toBe(500);
    expect(headers["content-type"]).toContain("application/json");
    expect(JSON.parse(state.body)).toEqual({
      error: { message: "boom", name: "Error", status: 500 },
    });
    expect(server.ssrFixStacktrace).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("renders and transforms document error overlays", async () => {
    const server = {
      config: { root: "/workspace" },
      ssrFixStacktrace: vi.fn(),
      ssrLoadModule: vi.fn(async () => ({
        buildErrorOverlayHtml: ({ message }: { message: string }) => `<html>${message}</html>`,
      })),
      transformIndexHtml: vi.fn(async (_url: string, html: string) => `${html}<!-- vite -->`),
    } as unknown as ViteDevServer;
    const request = { headers: {} } as unknown as IncomingMessage;
    const { headers, response, state } = createResponse();

    await handleDevError(server, request, response, vi.fn(), "/broken", new Error("boom"));

    expect(state.statusCode).toBe(500);
    expect(headers["content-type"]).toContain("text/html");
    expect(state.body).toBe("<html>boom</html><!-- vite -->");
  });

  it("renders the route table in rich not-found responses", async () => {
    const server = {
      ssrLoadModule: vi.fn(async () => ({
        buildDevNotFoundHtml: (options: unknown) => JSON.stringify(options),
      })),
      transformIndexHtml: vi.fn(async (_url: string, html: string) => html),
    } as unknown as ViteDevServer;
    const { headers, response, state } = createResponse();
    const next = vi.fn();

    await serveDevNotFound(server, response, next, "/missing", "/missing", {
      apiRoutes: [{ path: "/api/health" }] as any,
      app: {
        routes: [{ path: "/", render: "ssr" }],
      } as any,
    });

    expect(state.statusCode).toBe(404);
    expect(headers["content-type"]).toContain("text/html");
    expect(JSON.parse(state.body)).toEqual({
      apiRoutes: [{ path: "/api/health" }],
      requestedPath: "/missing",
      routes: [{ path: "/", render: "ssr" }],
    });
    expect(next).not.toHaveBeenCalled();
  });
});
