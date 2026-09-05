import { describe, expect, it } from "vitest";

import type { GraphSnapshot } from "../src/graph-snapshot.ts";
import {
  collectMcpRouteCollisionChecks,
  collectWebmcpRouteChecks,
} from "../src/verification-graph.ts";
import type { Check } from "../src/verification-helpers.ts";

function graph(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    api: [],
    capabilities: [],
    constraints: [],
    mcpAuthenticated: false,
    mcpEndpoint: null,
    mode: "manifest",
    prachtGraphVersion: 2,
    routes: [],
    ...overrides,
  };
}

describe("collectMcpRouteCollisionChecks", () => {
  it("rejects an API route that shadows the remote MCP endpoint", () => {
    const checks: Check[] = [];
    collectMcpRouteCollisionChecks(
      graph({
        api: [
          {
            file: "/src/api/mcp.ts",
            hasDefaultHandler: false,
            methods: ["POST"],
            path: "/api/mcp",
          },
        ],
        mcpEndpoint: "/api/mcp",
      }),
      checks,
    );

    expect(checks).toEqual([
      expect.objectContaining({ message: expect.stringContaining("collides"), status: "error" }),
    ]);
  });

  it("allows distinct API and MCP paths", () => {
    const checks: Check[] = [];
    collectMcpRouteCollisionChecks(
      graph({
        api: [
          {
            file: "/src/api/health.ts",
            hasDefaultHandler: false,
            methods: ["GET"],
            path: "/api/health",
          },
        ],
        mcpEndpoint: "/mcp",
      }),
      checks,
    );
    expect(checks).toEqual([]);
  });

  it.each(["/api/:name", "/api/*"])(
    "rejects a dynamic API route %s that matches the MCP endpoint",
    (path) => {
      const checks: Check[] = [];
      collectMcpRouteCollisionChecks(
        graph({
          api: [
            {
              file: "/src/api/[name].ts",
              hasDefaultHandler: false,
              methods: ["POST"],
              path,
            },
          ],
          mcpEndpoint: "/api/mcp",
        }),
        checks,
      );

      expect(checks).toEqual([
        expect.objectContaining({ message: expect.stringContaining("collides"), status: "error" }),
      ]);
    },
  );
});

describe("collectWebmcpRouteChecks", () => {
  const capability = (name: string, transports: string[]) =>
    ({ name, transports }) as GraphSnapshot["capabilities"][number];

  it("accepts route-scoped WebMCP capabilities", () => {
    const checks: Check[] = [];
    collectWebmcpRouteChecks(
      graph({
        capabilities: [capability("notes.search", ["http", "webmcp"])],
        routes: [
          {
            ...({ path: "/notes" } as GraphSnapshot["routes"][number]),
            capabilities: ["notes.search"],
          },
        ],
      }),
      checks,
    );

    expect(checks).toEqual([
      expect.objectContaining({ message: expect.stringContaining("route-scoped"), status: "ok" }),
    ]);
  });

  it("rejects page-tool activation for a capability without WebMCP exposure", () => {
    const checks: Check[] = [];
    collectWebmcpRouteChecks(
      graph({
        capabilities: [capability("notes.search", ["http"])],
        routes: [
          {
            ...({ path: "/notes" } as GraphSnapshot["routes"][number]),
            capabilities: ["notes.search"],
          },
        ],
      }),
      checks,
    );

    expect(checks).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("does not set expose.webmcp"),
        status: "error",
      }),
    ]);
  });

  it("warns when a WebMCP capability is not active on any route", () => {
    const checks: Check[] = [];
    collectWebmcpRouteChecks(
      graph({ capabilities: [capability("notes.search", ["http", "webmcp"])] }),
      checks,
    );

    expect(checks).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("no route activates"),
        status: "warning",
      }),
    ]);
  });
});
