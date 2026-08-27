import { describe, expect, it } from "vitest";

import type { GraphSnapshot } from "../src/graph-snapshot.ts";
import { collectMcpRouteCollisionChecks } from "../src/verification-graph.ts";
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
});
