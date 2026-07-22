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
    render: "ssr",
    revalidate: null,
    shell: null,
    shellFile: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    prachtGraphVersion: 1,
    mode: "manifest",
    routes: [],
    api: [],
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
          { file: "/src/api/z.ts", methods: ["GET"], path: "/api/z" },
          { file: "/src/api/a.ts", methods: ["GET"], path: "/api/a" },
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
      api: [{ file: "/src/api/health.ts", methods: ["GET"], path: "/api/health" }],
      constraints: [{ kind: "require-head", pattern: "**" }],
    });
    const head = makeSnapshot({
      api: [
        { file: "/src/api/health.ts", methods: ["GET", "POST"], path: "/api/health" },
        { file: "/src/api/webhooks/stripe.ts", methods: ["POST"], path: "/api/webhooks/stripe" },
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
