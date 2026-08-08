import { describe, expect, it } from "vitest";

import {
  diffGraphSnapshots,
  formatPlanMarkdown,
  formatPlanText,
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
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    prachtGraphVersion: 1,
    mode: "manifest",
    routes: [],
    api: [],
    capabilities: [],
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
        makeRoute("/dashboard", { middleware: ["auth", "audit"], render: "spa" }),
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
