import { describe, expect, it } from "vitest";

import { formatCapabilityTransports } from "../src/capability-exposure.ts";
import { formatDevBanner } from "../src/dev-banner.ts";

const capability = (overrides: Record<string, unknown> = {}) => ({
  agentPolicy: null,
  description: null,
  effect: "read",
  hasUi: false as const,
  httpPath: null,
  input: null,
  middleware: [],
  name: "notes.purge",
  output: null,
  source: "./capabilities/purge.ts",
  title: null,
  transports: ["mcp"],
  ...overrides,
});

describe("formatCapabilityTransports", () => {
  it("marks MCP tools the endpoint would not serve, with the runtime's rule", () => {
    const served = { mcpEndpoint: "/mcp", mcpRuntimeStatus: "ready" as const };
    expect(formatCapabilityTransports(capability(), served)).toBe("mcp");
    expect(formatCapabilityTransports(capability(), { mcpEndpoint: null })).toBe("mcp(unserved)");
    expect(formatCapabilityTransports(capability({ effect: "destructive" }), served)).toBe(
      "mcp(unserved)",
    );
    // A scoped tool needs OAuth: without agents.mcp.auth nothing serves it.
    const scoped = capability({ mcpScopes: ["notes.write"] });
    expect(formatCapabilityTransports(scoped, served)).toBe("mcp(unserved)");
    expect(formatCapabilityTransports(scoped, { ...served, mcpAuthenticated: true })).toBe("mcp");
    expect(
      formatCapabilityTransports(capability(), { ...served, mcpRuntimeStatus: "unverified" }),
    ).toBe("mcp(unverified)");
    expect(formatCapabilityTransports(capability({ transports: [] }), served)).toBe("private");
  });

  it("drives the dev banner's EXPOSURE column", () => {
    const banner = formatDevBanner({
      apiRoutes: [],
      capabilities: [capability({ mcpScopes: ["notes.write"], transports: ["http", "mcp"] })],
      color: false,
      localUrls: ["http://localhost:3000/"],
      mcpEndpoint: "/mcp",
      routes: [],
    });
    expect(banner).toContain("http,mcp(unserved)");
  });
});
