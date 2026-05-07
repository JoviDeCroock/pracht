import { describe, expect, it } from "vitest";

import { defineApp, group, resolveApp, route } from "../src/index.ts";
import {
  buildSpeculationRules,
  getAppSpeculationRules,
  normalizeSpeculation,
} from "../src/runtime-speculation.ts";

describe("normalizeSpeculation", () => {
  it("expands a string mode to a config object", () => {
    expect(normalizeSpeculation("prefetch")).toEqual({ mode: "prefetch" });
    expect(normalizeSpeculation("prerender")).toEqual({ mode: "prerender" });
  });

  it("returns object configs unchanged", () => {
    expect(normalizeSpeculation({ mode: "prefetch", eagerness: "eager" })).toEqual({
      mode: "prefetch",
      eagerness: "eager",
    });
  });

  it("returns null for an unset option", () => {
    expect(normalizeSpeculation(undefined)).toBeNull();
  });
});

describe("buildSpeculationRules", () => {
  it("returns null when no route opts in", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [route("/", "./routes/index.tsx")],
      }),
    );
    expect(buildSpeculationRules(resolved.routes)).toBeNull();
  });

  it("emits a prefetch rule with default moderate eagerness", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [route("/", "./routes/index.tsx", { speculation: "prefetch" })],
      }),
    );
    expect(buildSpeculationRules(resolved.routes)).toEqual({
      prefetch: [
        {
          source: "document",
          where: { href_matches: ["/"] },
          eagerness: "moderate",
        },
      ],
    });
  });

  it("emits a prerender rule with default conservative eagerness", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [route("/about", "./routes/about.tsx", { speculation: "prerender" })],
      }),
    );
    expect(buildSpeculationRules(resolved.routes)).toEqual({
      prerender: [
        {
          source: "document",
          where: { href_matches: ["/about"] },
          eagerness: "conservative",
        },
      ],
    });
  });

  it("translates dynamic segments to URLPattern syntax", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [
          route("/blog/:slug", "./routes/blog.tsx", { speculation: "prefetch" }),
          route("/files/*", "./routes/files.tsx", { speculation: "prefetch" }),
        ],
      }),
    );
    const rules = buildSpeculationRules(resolved.routes);
    expect(rules?.prefetch?.[0].where.href_matches).toEqual(["/blog/:slug", "/files/*"]);
  });

  it("groups routes by mode and eagerness", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [
          route("/a", "./a.tsx", { speculation: { mode: "prefetch", eagerness: "eager" } }),
          route("/b", "./b.tsx", { speculation: { mode: "prefetch", eagerness: "eager" } }),
          route("/c", "./c.tsx", { speculation: { mode: "prefetch", eagerness: "moderate" } }),
          route("/d", "./d.tsx", { speculation: "prerender" }),
        ],
      }),
    );
    const rules = buildSpeculationRules(resolved.routes);
    expect(rules?.prefetch).toHaveLength(2);
    expect(rules?.prerender).toHaveLength(1);

    const eager = rules?.prefetch?.find((r) => r.eagerness === "eager");
    expect(eager?.where.href_matches.sort()).toEqual(["/a", "/b"]);
  });

  it("inherits speculation from a group", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [
          group({ pathPrefix: "/docs", speculation: "prefetch" }, [
            route("/intro", "./intro.tsx"),
            route("/api", "./api.tsx"),
          ]),
        ],
      }),
    );
    const rules = buildSpeculationRules(resolved.routes);
    expect(rules?.prefetch?.[0].where.href_matches).toEqual(["/docs/intro", "/docs/api"]);
  });

  it("lets a route override an inherited group setting", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [
          group({ speculation: "prefetch" }, [
            route("/", "./root.tsx"),
            route("/heavy", "./heavy.tsx", { speculation: "prerender" }),
          ]),
        ],
      }),
    );
    const rules = buildSpeculationRules(resolved.routes);
    expect(rules?.prefetch?.[0].where.href_matches).toEqual(["/"]);
    expect(rules?.prerender?.[0].where.href_matches).toEqual(["/heavy"]);
  });
});

describe("getAppSpeculationRules", () => {
  it("memoizes the result per resolved app instance", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [route("/", "./index.tsx", { speculation: "prefetch" })],
      }),
    );
    const first = getAppSpeculationRules(resolved);
    const second = getAppSpeculationRules(resolved);
    expect(first).toBe(second);
  });
});
