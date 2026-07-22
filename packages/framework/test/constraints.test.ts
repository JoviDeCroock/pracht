import { describe, expect, it } from "vitest";

import {
  defineApp,
  evaluateConstraints,
  forbidRenderMode,
  matchRoutePattern,
  requireHead,
  requireMiddleware,
  requireRenderMode,
  requireShell,
  resolveApp,
  route,
} from "../src/index.ts";

describe("matchRoutePattern", () => {
  it("matches literal paths segment-wise", () => {
    expect(matchRoutePattern("/pricing", "/pricing")).toBe(true);
    expect(matchRoutePattern("/pricing", "/pricing/teams")).toBe(false);
    expect(matchRoutePattern("/pricing", "/blog")).toBe(false);
  });

  it("matches one segment with *", () => {
    expect(matchRoutePattern("/blog/*", "/blog/:slug")).toBe(true);
    expect(matchRoutePattern("/blog/*", "/blog")).toBe(false);
    expect(matchRoutePattern("/blog/*", "/blog/:slug/comments")).toBe(false);
  });

  it("matches zero or more segments with a trailing **", () => {
    expect(matchRoutePattern("/app/**", "/app")).toBe(true);
    expect(matchRoutePattern("/app/**", "/app/settings")).toBe(true);
    expect(matchRoutePattern("/app/**", "/app/settings/billing")).toBe(true);
    expect(matchRoutePattern("/app/**", "/admin")).toBe(false);
    expect(matchRoutePattern("**", "/anything/at/all")).toBe(true);
  });

  it("rejects ** in a non-final segment", () => {
    expect(() => matchRoutePattern("/app/**/edit", "/app/x/edit")).toThrow(/final segment/);
  });
});

describe("constraint helpers", () => {
  it("validate patterns and arguments", () => {
    expect(() => requireMiddleware("app/**", "auth")).toThrow(/starting with "\/"/);
    expect(() => requireMiddleware("/app/**")).toThrow(/at least one middleware/);
    expect(() => requireShell("/app/**")).toThrow(/at least one shell/);
    expect(() => requireRenderMode("/app/**")).toThrow(/at least one render mode/);
    expect(requireHead("**")).toEqual({ kind: "require-head", pattern: "**" });
  });
});

describe("evaluateConstraints", () => {
  const routes = [
    { path: "/", middleware: [], render: "ssg", shell: "public" },
    { path: "/app/dashboard", middleware: ["auth"], render: "ssr", shell: "app" },
    { path: "/app/settings", middleware: [], render: "spa", shell: null },
  ];

  it("flags missing required middleware", () => {
    const violations = evaluateConstraints(routes, [requireMiddleware("/app/**", "auth")]);
    expect(violations).toHaveLength(1);
    expect(violations[0].routePath).toBe("/app/settings");
    expect(violations[0].message).toContain('missing required middleware "auth"');
  });

  it("flags routes outside the allowed shells", () => {
    const violations = evaluateConstraints(routes, [requireShell("/app/**", "app")]);
    expect(violations).toHaveLength(1);
    expect(violations[0].routePath).toBe("/app/settings");
  });

  it("enforces allowed and forbidden render modes", () => {
    expect(evaluateConstraints(routes, [requireRenderMode("/", "ssg", "isg")])).toHaveLength(0);
    expect(evaluateConstraints(routes, [forbidRenderMode("/app/**", "ssg")])).toHaveLength(0);

    const violations = evaluateConstraints(routes, [forbidRenderMode("/app/**", "spa")]);
    expect(violations).toHaveLength(1);
    expect(violations[0].routePath).toBe("/app/settings");
  });

  it("evaluates requireHead through the injected lookup and skips unknowns", () => {
    const violations = evaluateConstraints(routes, [requireHead("**")], {
      routeHasHead: (route) => (route.path === "/" ? undefined : route.path === "/app/dashboard"),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].routePath).toBe("/app/settings");
  });
});

describe("defineApp constraints", () => {
  it("carries constraints through defineApp and resolveApp", () => {
    const constraints = [requireMiddleware("/app/**", "auth")];
    const app = defineApp({
      middleware: { auth: "./middleware/auth.ts" },
      routes: [route("/app/dashboard", "./routes/dashboard.tsx", { middleware: ["auth"] })],
      constraints,
    });

    expect(app.constraints).toBe(constraints);
    expect(resolveApp(app).constraints).toBe(constraints);
  });
});
