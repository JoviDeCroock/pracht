import { describe, expect, it } from "vitest";

import {
  diffGraphSnapshots,
  formatPlanMarkdown,
  formatPlanText,
  GRAPH_SNAPSHOT_VERSION,
  normalizeGraphSnapshot,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "../src/graph-snapshot.js";

function makeRoute(path: string, overrides: Record<string, unknown> = {}) {
  return {
    file: `./routes${path === "/" ? "/index" : path}.tsx`,
    hydration: null,
    id: path === "/" ? "index" : path.slice(1).replaceAll("/", "-"),
    loaderCache: null,
    loaderFile: null,
    middleware: [],
    path,
    prefetch: null,
    render: "ssr",
    revalidate: null,
    shell: null,
    shellFile: null,
    speculation: null,
    streaming: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    prachtGraphVersion: GRAPH_SNAPSHOT_VERSION,
    mode: "manifest",
    routes: [],
    api: [],
    capabilities: [],
    mcpEndpoint: null,
    mcpAuthenticated: false,
    mcpAuth: null,
    constraints: [],
    ...overrides,
  };
}

describe("normalizeGraphSnapshot", () => {
  it("sorts routes and api by path for stable git diffs", () => {
    const snapshot = normalizeGraphSnapshot(
      makeSnapshot({
        routes: [makeRoute("/b"), makeRoute("/a")],
        api: [
          { file: "/src/api/z.ts", hasDefaultHandler: false, methods: ["GET"], path: "/api/z" },
          { file: "/src/api/a.ts", hasDefaultHandler: false, methods: ["GET"], path: "/api/a" },
        ],
      }),
    );

    expect(snapshot.routes.map((route) => route.path)).toEqual(["/a", "/b"]);
    expect(snapshot.api.map((route) => route.path)).toEqual(["/api/a", "/api/z"]);
  });

  it("serializes identically regardless of input order", () => {
    const left = makeSnapshot({ routes: [makeRoute("/a"), makeRoute("/b")] });
    const right = makeSnapshot({ routes: [makeRoute("/b"), makeRoute("/a")] });

    expect(serializeGraphSnapshot(left)).toBe(serializeGraphSnapshot(right));
  });

  it("only serializes the destructive MCP opt-in when it is enabled", () => {
    expect(JSON.parse(serializeGraphSnapshot(makeSnapshot()))).not.toHaveProperty("mcpDestructive");
    expect(
      JSON.parse(serializeGraphSnapshot(makeSnapshot({ mcpDestructive: true }))).mcpDestructive,
    ).toBe(true);
  });

  it("normalizes snapshots written before streaming metadata existed", () => {
    const route = makeRoute("/legacy");
    // @ts-expect-error -- an older committed snapshot has no streaming field.
    delete route.streaming;

    const snapshot = normalizeGraphSnapshot(makeSnapshot({ routes: [route] }));

    expect(snapshot.routes[0].streaming).toBeNull();
  });
});

describe("diffGraphSnapshots", () => {
  it("reports identical graphs", () => {
    const snapshot = makeSnapshot({ routes: [makeRoute("/")] });
    const diff = diffGraphSnapshots(snapshot, snapshot);

    expect(diff.identical).toBe(true);
    expect(diff.addedRoutes).toEqual([]);
  });

  it("detects added, removed, and changed routes", () => {
    const base = makeSnapshot({
      routes: [
        makeRoute("/"),
        makeRoute("/dashboard", { middleware: ["auth"] }),
        makeRoute("/legacy"),
      ],
    });
    const head = makeSnapshot({
      routes: [
        makeRoute("/"),
        makeRoute("/dashboard", {
          markdown: true,
          middleware: ["auth", "audit"],
          render: "spa",
          streaming: true,
        }),
        makeRoute("/pricing", { render: "isg", revalidate: { kind: "time", seconds: 3600 } }),
      ],
    });

    const diff = diffGraphSnapshots(base, head);

    expect(diff.identical).toBe(false);
    expect(diff.addedRoutes.map((route) => route.path)).toEqual(["/pricing"]);
    expect(diff.removedRoutes.map((route) => route.path)).toEqual(["/legacy"]);
    expect(diff.changedRoutes).toEqual([
      {
        path: "/dashboard",
        changes: [
          { field: "render", from: "ssr", to: "spa" },
          { field: "middleware", from: ["auth"], to: ["auth", "audit"] },
          { field: "streaming", from: null, to: true },
          { field: "markdown", from: null, to: true },
        ],
      },
    ]);
  });

  it("detects api and constraint changes", () => {
    const base = makeSnapshot({
      api: [
        {
          file: "/src/api/health.ts",
          hasDefaultHandler: false,
          methods: ["GET"],
          path: "/api/health",
        },
      ],
      constraints: [{ kind: "require-head", pattern: "**" }],
    });
    const head = makeSnapshot({
      api: [
        {
          file: "/src/api/health.ts",
          hasDefaultHandler: false,
          methods: ["GET", "POST"],
          path: "/api/health",
        },
        {
          file: "/src/api/webhooks/stripe.ts",
          hasDefaultHandler: false,
          methods: ["POST"],
          path: "/api/webhooks/stripe",
        },
      ],
      constraints: [
        { kind: "require-head", pattern: "**" },
        { kind: "require-middleware", pattern: "/app/**", middleware: ["auth"] },
      ],
    });

    const diff = diffGraphSnapshots(base, head);

    expect(diff.addedApi.map((route) => route.path)).toEqual(["/api/webhooks/stripe"]);
    expect(diff.changedApi).toEqual([
      {
        path: "/api/health",
        changes: [{ field: "methods", from: ["GET"], to: ["GET", "POST"] }],
      },
    ]);
    expect(diff.addedConstraints).toEqual([
      { kind: "require-middleware", pattern: "/app/**", middleware: ["auth"] },
    ]);
    expect(diff.removedConstraints).toEqual([]);
  });
});

describe("plan formatters", () => {
  const base = makeSnapshot({ routes: [makeRoute("/dashboard", { middleware: ["auth"] })] });
  const head = makeSnapshot({
    routes: [
      makeRoute("/dashboard", { middleware: ["auth", "audit"] }),
      makeRoute("/pricing", { render: "isg", shell: "public" }),
    ],
  });

  it("formats a readable text plan", () => {
    const text = formatPlanText(diffGraphSnapshots(base, head), { base: "origin/main" });

    expect(text).toContain("Pracht plan (base: origin/main)");
    expect(text).toContain("+ route /pricing");
    expect(text).toContain("render=isg");
    expect(text).toContain("shell=public");
    expect(text).toContain("~ route /dashboard");
    expect(text).toContain("middleware: [auth] → [auth, audit]");
  });

  it("formats markdown with a diff fence and summary", () => {
    const markdown = formatPlanMarkdown(diffGraphSnapshots(base, head), {
      base: "origin/main",
      budgets: new Map([["/pricing", { gzipBytes: 4300, limitBytes: 25600, ok: true }]]),
    });

    expect(markdown).toContain("### App graph changes (base: `origin/main`)");
    expect(markdown).toContain("1 added, 1 changed.");
    expect(markdown).toContain("```diff");
    expect(markdown).toContain("+ route /pricing");
    expect(markdown).toMatch(/\(4\.\dkb gz \/ 25\.0kb limit\)/);
  });

  it("reports no changes for identical graphs", () => {
    expect(formatPlanText(diffGraphSnapshots(base, base), { base: "origin/main" })).toContain(
      "No app graph changes.",
    );
  });
});

// ---------------------------------------------------------------------------
// Capabilities: the agent-facing half of the graph
// ---------------------------------------------------------------------------

function makeCapability(overrides: Record<string, unknown> = {}) {
  return {
    agentPolicy: "require",
    description: "Find notes matching a query.",
    effect: "read",
    hasUi: false as const,
    httpPath: "/api/capabilities/notes/search",
    input: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    middleware: ["auth"],
    name: "notes.search",
    output: { type: "object", properties: { notes: { type: "array" } } },
    source: "./capabilities/notes-search.ts",
    title: "Search notes",
    transports: ["http"],
    ...overrides,
  };
}

function diffCapability(overrides: Record<string, unknown>) {
  return diffGraphSnapshots(
    makeSnapshot({ capabilities: [makeCapability()] }),
    makeSnapshot({ capabilities: [makeCapability(overrides)] }),
  );
}

describe("capability diff", () => {
  it("flags adding a WebMCP tool to a route as an agent-surface widening", () => {
    const diff = diffGraphSnapshots(
      makeSnapshot({ routes: [makeRoute("/notes")] }),
      makeSnapshot({ routes: [makeRoute("/notes", { capabilities: ["notes.search"] })] }),
    );

    expect(diff.changedRoutes[0]?.changes).toContainEqual({
      field: "capabilities",
      from: null,
      to: ["notes.search"],
    });
    expect(diff.widensAgentSurface).toBe(true);
  });

  it("flags enabling the MCP endpoint as an agent-surface widening", () => {
    const capability = makeCapability({ transports: ["mcp"], httpPath: null });
    const diff = diffGraphSnapshots(
      makeSnapshot({ capabilities: [capability] }),
      makeSnapshot({ capabilities: [capability], mcpEndpoint: "/mcp" }),
    );

    expect(diff.mcpEndpointChange).toEqual({
      field: "mcpEndpoint",
      from: null,
      to: "/mcp",
    });
    expect(diff.widensAgentSurface).toBe(true);
    expect(formatPlanText(diff, { base: "origin/main" })).toContain(
      "! mcp endpoint /mcp enabled — declared MCP capabilities are now reachable by agents",
    );
  });

  it("flags enabling destructive MCP tools as an agent-surface widening", () => {
    const capability = makeCapability({
      effect: "destructive",
      transports: ["mcp"],
      httpPath: null,
    });
    const base = makeSnapshot({ capabilities: [capability], mcpEndpoint: "/mcp" });
    const enabled = diffGraphSnapshots(
      base,
      makeSnapshot({
        capabilities: [capability],
        mcpEndpoint: "/mcp",
        mcpDestructive: true,
      }),
    );

    expect(enabled.mcpDestructiveChange).toEqual({
      field: "mcpDestructive",
      from: false,
      to: true,
    });
    expect(enabled.widensAgentSurface).toBe(true);
    expect(formatPlanText(enabled, { base: "origin/main" })).toContain(
      "! mcp destructive tools enabled",
    );

    const disabled = diffGraphSnapshots(
      makeSnapshot({ mcpEndpoint: "/mcp", mcpDestructive: true }),
      makeSnapshot({ mcpEndpoint: "/mcp" }),
    );
    expect(disabled.widensAgentSurface).toBe(false);
    expect(formatPlanText(disabled, { base: "origin/main" })).toContain(
      "- mcp destructive tools disabled",
    );
  });

  it("reports moving or disabling the MCP endpoint without a widening alarm", () => {
    const moved = diffGraphSnapshots(
      makeSnapshot({ mcpEndpoint: "/mcp" }),
      makeSnapshot({ mcpEndpoint: "/agent/mcp" }),
    );
    expect(moved.widensAgentSurface).toBe(false);
    expect(formatPlanText(moved, { base: "origin/main" })).toContain(
      "~ mcp endpoint /mcp → /agent/mcp",
    );

    const disabled = diffGraphSnapshots(makeSnapshot({ mcpEndpoint: "/mcp" }), makeSnapshot());
    expect(disabled.widensAgentSurface).toBe(false);
    expect(formatPlanText(disabled, { base: "origin/main" })).toContain(
      "- mcp endpoint /mcp disabled",
    );
  });

  it("tracks OAuth protection and warns when it is removed from a live endpoint", () => {
    const enabled = diffGraphSnapshots(
      makeSnapshot({ mcpEndpoint: "/mcp" }),
      makeSnapshot({ mcpEndpoint: "/mcp", mcpAuthenticated: true }),
    );
    expect(enabled.mcpAuthenticationChange).toEqual({
      field: "mcpAuthenticated",
      from: false,
      to: true,
    });
    expect(enabled.widensAgentSurface).toBe(false);
    expect(formatPlanText(enabled, { base: "origin/main" })).toContain(
      "+ mcp oauth protection enabled",
    );

    const disabled = diffGraphSnapshots(
      makeSnapshot({ mcpEndpoint: "/mcp", mcpAuthenticated: true }),
      makeSnapshot({ mcpEndpoint: "/mcp" }),
    );
    expect(disabled.widensAgentSurface).toBe(true);
    expect(formatPlanText(disabled, { base: "origin/main" })).toContain(
      "! mcp oauth protection disabled — remote MCP endpoint no longer requires bearer tokens",
    );
  });

  it("tracks OAuth policy fields and flags guard weakening", () => {
    const auth = {
      authorizationServers: ["https://auth.example"],
      requiredScopes: ["notes.read", "notes.write"],
      resource: "https://app.example/mcp",
      scopesSupported: ["notes.read", "notes.write"],
      verify: "./server/mcp-token.ts",
    };
    const base = makeSnapshot({
      mcpEndpoint: "/mcp",
      mcpAuthenticated: true,
      mcpAuth: auth,
    });
    const head = makeSnapshot({
      mcpEndpoint: "/mcp",
      mcpAuthenticated: true,
      mcpAuth: {
        ...auth,
        authorizationServers: [...auth.authorizationServers, "https://other.example"],
        requiredScopes: ["notes.read"],
        resource: "https://api.example/mcp",
        verify: "./server/other-token.ts",
      },
    });

    const diff = diffGraphSnapshots(base, head);
    expect(diff.mcpAuthChanges.map((change) => change.field)).toEqual([
      "resource",
      "authorizationServers",
      "requiredScopes",
      "verify",
    ]);
    expect(diff.widensAgentSurface).toBe(true);
    const text = formatPlanText(diff, { base: "origin/main" });
    expect(text).toContain("! mcp oauth authorizationServers:");
    expect(text).toContain("! mcp oauth requiredScopes:");
    expect(text).toContain("~ mcp oauth resource:");
  });

  it("does not classify adding a required OAuth scope as a widening", () => {
    const auth = {
      authorizationServers: ["https://auth.example"],
      requiredScopes: ["notes.read"],
      resource: "https://app.example/mcp",
      scopesSupported: ["notes.read", "notes.write"],
      verify: "./server/mcp-token.ts",
    };
    const diff = diffGraphSnapshots(
      makeSnapshot({ mcpEndpoint: "/mcp", mcpAuthenticated: true, mcpAuth: auth }),
      makeSnapshot({
        mcpEndpoint: "/mcp",
        mcpAuthenticated: true,
        mcpAuth: { ...auth, requiredScopes: ["notes.read", "notes.write"] },
      }),
    );

    expect(diff.widensAgentSurface).toBe(false);
    expect(formatPlanText(diff, { base: "origin/main" })).toContain("~ mcp oauth requiredScopes:");
  });

  it("flags a capability becoming reachable by remote agents", () => {
    const diff = diffCapability({ transports: ["http", "mcp"] });

    expect(diff.widensAgentSurface).toBe(true);
    expect(diff.capabilityChanges[0]).toMatchObject({
      kind: "exposure-added",
      capability: "notes.search",
      severity: "warn",
    });
    expect(diff.capabilityChanges[0].detail).toContain("reachable by agents");
  });

  it("flags agentPolicy being downgraded, but not strengthened", () => {
    expect(diffCapability({ agentPolicy: "observe" }).capabilityChanges[0]).toMatchObject({
      kind: "policy-weakened",
      severity: "warn",
    });

    const strengthened = diffGraphSnapshots(
      makeSnapshot({ capabilities: [makeCapability({ agentPolicy: null })] }),
      makeSnapshot({ capabilities: [makeCapability()] }),
    );
    expect(strengthened.widensAgentSurface).toBe(false);
    expect(strengthened.capabilityChanges[0].kind).toBe("policy-strengthened");
  });

  it("flags middleware being dropped", () => {
    const diff = diffCapability({ middleware: [] });

    expect(diff.capabilityChanges[0]).toMatchObject({
      kind: "middleware-removed",
      severity: "warn",
    });
    expect(diff.capabilityChanges[0].detail).toContain("auth");
  });

  it("flags a destructive capability being reclassified", () => {
    const diff = diffGraphSnapshots(
      makeSnapshot({ capabilities: [makeCapability({ effect: "destructive" })] }),
      makeSnapshot({ capabilities: [makeCapability({ effect: "write" })] }),
    );

    expect(diff.capabilityChanges[0]).toMatchObject({ kind: "effect-changed", severity: "warn" });
  });

  it("separates a new exposed capability from a new private one", () => {
    const exposed = diffGraphSnapshots(
      makeSnapshot(),
      makeSnapshot({
        capabilities: [makeCapability()],
      }),
    );
    expect(exposed.capabilityChanges[0]).toMatchObject({ kind: "added", severity: "warn" });
    expect(exposed.widensAgentSurface).toBe(true);

    const privateOne = diffGraphSnapshots(
      makeSnapshot(),
      makeSnapshot({ capabilities: [makeCapability({ transports: [], httpPath: null })] }),
    );
    expect(privateOne.capabilityChanges[0]).toMatchObject({ kind: "added", severity: "info" });
    expect(privateOne.widensAgentSurface).toBe(false);
  });

  it("reports removals without alarm", () => {
    const diff = diffGraphSnapshots(
      makeSnapshot({ capabilities: [makeCapability()] }),
      makeSnapshot(),
    );

    expect(diff.capabilityChanges[0]).toMatchObject({ kind: "removed", severity: "info" });
    expect(diff.widensAgentSurface).toBe(false);
  });

  it("catches input schema widenings, including nested bounds", () => {
    const details = (input: Record<string, unknown>) =>
      diffCapability({ input }).capabilityChanges.map((change) => change.detail);

    expect(details({ ...makeCapability().input, required: [] })).toContain(
      "input: no longer requires query",
    );

    expect(details({ ...makeCapability().input, additionalProperties: true })).toContain(
      "input: additionalProperties opened up",
    );

    expect(
      details({
        ...makeCapability().input,
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 5000 },
        },
      }),
    ).toContain("input.limit: maximum raised (50 → 5000)");

    expect(
      details({
        ...makeCapability().input,
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1 },
        },
      }),
    ).toContain("input.limit: maximum raised (50 → unbounded)");
  });

  it("stays quiet on narrowings and on no change", () => {
    const narrowed = diffCapability({
      input: {
        ...makeCapability().input,
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
    });
    expect(narrowed.capabilityChanges).toEqual([]);

    const unchanged = diffCapability({});
    expect(unchanged.capabilityChanges).toEqual([]);
    expect(unchanged.identical).toBe(true);
  });

  it("treats a snapshot without capabilities as having none", () => {
    const legacy = makeSnapshot();
    // @ts-expect-error — a snapshot committed before capabilities were tracked.
    delete legacy.capabilities;

    expect(diffGraphSnapshots(legacy, makeSnapshot()).capabilityChanges).toEqual([]);
  });
});

describe("plan formatters with capability changes", () => {
  const base = makeSnapshot({ capabilities: [makeCapability()] });
  const head = makeSnapshot({ capabilities: [makeCapability({ transports: ["http", "mcp"] })] });

  it("marks widenings in the text plan", () => {
    const text = formatPlanText(diffGraphSnapshots(base, head), { base: "origin/main" });

    expect(text).toContain("! capability notes.search  now exposed via mcp");
    expect(text).toContain("widens what agents can reach");
  });

  it("headlines widenings above the markdown diff", () => {
    const markdown = formatPlanMarkdown(diffGraphSnapshots(base, head), { base: "origin/main" });

    expect(markdown).toContain("⚠️ **This change widens what agents can reach");
    expect(markdown).toContain("1 capability change.");
    expect(markdown).toContain("! capability notes.search");
  });

  it("says nothing extra when the agent surface did not move", () => {
    const renamed = makeSnapshot({
      capabilities: [makeCapability({ httpPath: "/api/search" })],
    });
    const markdown = formatPlanMarkdown(diffGraphSnapshots(base, renamed), {
      base: "origin/main",
    });

    expect(markdown).not.toContain("widens what agents can reach");
    expect(markdown).toContain("~ capability notes.search  HTTP path");
  });
});
