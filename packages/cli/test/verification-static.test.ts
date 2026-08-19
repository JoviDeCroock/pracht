import { describe, expect, it } from "vitest";

import type { GraphSnapshot } from "../src/graph-snapshot.ts";
import type { Check } from "../src/verification-helpers.ts";
import { collectStaticExportChecks } from "../src/verification-static.ts";

function graph(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    api: [],
    capabilities: [],
    routes: [],
    ...overrides,
  } as unknown as GraphSnapshot;
}

function route(overrides: Record<string, unknown>): GraphSnapshot["routes"][number] {
  return {
    hydration: null,
    loaderFile: null,
    middleware: [],
    path: "/",
    render: "ssg",
    ...overrides,
  } as unknown as GraphSnapshot["routes"][number];
}

function run(
  snapshot: GraphSnapshot,
  options: { loaderRoutePaths?: ReadonlySet<string>; staticTarget?: boolean } = {},
): Check[] {
  const checks: Check[] = [];
  collectStaticExportChecks(snapshot, checks, {
    loaderRoutePaths: options.loaderRoutePaths,
    staticTarget: options.staticTarget ?? true,
  });
  return checks;
}

function errors(checks: Check[]): string[] {
  return checks.filter((check) => check.status === "error").map((check) => check.message);
}

describe("collectStaticExportChecks", () => {
  it("does nothing for a non-static adapter", () => {
    const checks = run(
      graph({
        api: [{ path: "/api/ping" }],
        routes: [route({ path: "/dashboard", render: "ssr" })],
      } as Partial<GraphSnapshot>),
      { staticTarget: false },
    );
    expect(checks).toEqual([]);
  });

  it("passes a static app that uses no request-runtime features", () => {
    const checks = run(
      graph({
        routes: [route({ path: "/" }), route({ path: "/app", render: "spa" })],
      } as Partial<GraphSnapshot>),
      { loaderRoutePaths: new Set() },
    );
    expect(errors(checks)).toEqual([]);
    expect(checks.map((check) => check.status)).toEqual(["ok"]);
  });

  it("flags routes that render on a server, including an unset render mode", () => {
    const checks = run(
      graph({
        routes: [
          route({ path: "/" }),
          route({ path: "/dashboard", render: "ssr" }),
          route({ path: "/pricing", render: "isg" }),
          route({ path: "/implicit", render: null }),
        ],
      } as Partial<GraphSnapshot>),
    );
    const [message] = errors(checks);
    expect(message).toContain('/dashboard (render: "ssr")');
    expect(message).toContain('/pricing (render: "isg")');
    expect(message).toContain('/implicit (render: "ssr")');
    expect(message).not.toContain("/ (");
  });

  it("flags SPA routes with a loader or non-full hydration", () => {
    const checks = run(
      graph({
        routes: [
          route({ loaderFile: "/src/routes/a.tsx", path: "/with-loader", render: "spa" }),
          route({ hydration: "islands", path: "/islands", render: "spa" }),
          route({ hydration: "full", path: "/fine", render: "spa" }),
        ],
      } as Partial<GraphSnapshot>),
      { loaderRoutePaths: new Set(["/with-loader"]) },
    );
    const messages = errors(checks).join("\n");
    expect(messages).toContain("/with-loader");
    expect(messages).toContain('/islands (hydration: "islands")');
    expect(messages).not.toContain("/fine");
  });

  it("flags inline SPA loaders carried by live route metadata", () => {
    const checks = run(
      graph({
        routes: [route({ loaderFile: null, path: "/inline", render: "spa" })],
      } as Partial<GraphSnapshot>),
      { loaderRoutePaths: new Set(["/inline"]) },
    );

    expect(errors(checks).join("\n")).toContain("/inline");
  });

  it("flags route middleware, API routes, and network-exposed capabilities", () => {
    const checks = run(
      graph({
        api: [{ path: "/api/ping" }],
        capabilities: [
          { name: "notes.search", transports: ["http"] },
          { name: "notes.private", transports: [] },
        ],
        routes: [route({ middleware: ["/src/middleware/auth.ts"], path: "/gated" })],
      } as Partial<GraphSnapshot>),
    );
    const messages = errors(checks).join("\n");
    expect(messages).toContain("/gated");
    expect(messages).toContain("/api/ping");
    expect(messages).toContain("notes.search (http)");
    expect(messages).not.toContain("notes.private");
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const checks = run(
      graph({
        api: [{ path: "/api/ping" }],
        routes: [route({ path: "/dashboard", render: "ssr" })],
      } as Partial<GraphSnapshot>),
    );
    expect(errors(checks)).toHaveLength(2);
  });
});
