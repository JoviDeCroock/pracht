// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { defineApp, group, resolveApp, route } from "../src/index.ts";
import {
  buildSpeculationRules,
  getAppSpeculationRules,
  isSpeculationSuppressed,
  normalizeSpeculation,
  SPECULATION_EXCLUSION_SELECTORS,
} from "../src/runtime-speculation.ts";

const EXCLUSIONS = { not: { selector_matches: [...SPECULATION_EXCLUSION_SELECTORS] } };

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
          where: { and: [{ href_matches: ["/"] }, EXCLUSIONS] },
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
          where: { and: [{ href_matches: ["/about"] }, EXCLUSIONS] },
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
    expect(rules?.prefetch?.[0].where.and[0].href_matches).toEqual(["/blog/:slug", "/files/*"]);
  });

  it("escapes URLPattern metacharacters in static segments", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [
          route("/c++", "./routes/c-plus-plus.tsx", { speculation: "prefetch" }),
          route("/file(1)", "./routes/file-one.tsx", { speculation: "prefetch" }),
          route("/docs/a{b}", "./routes/braces.tsx", { speculation: "prefetch" }),
          route("/foo:bar", "./routes/colon.tsx", { speculation: "prefetch" }),
        ],
      }),
    );
    const rules = buildSpeculationRules(resolved.routes);
    expect(rules?.prefetch?.[0].where.and[0].href_matches).toEqual([
      "/c\\+\\+",
      "/file\\(1\\)",
      "/docs/a\\{b\\}",
      "/foo\\:bar",
    ]);
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
    expect(eager?.where.and[0].href_matches.sort()).toEqual(["/a", "/b"]);
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
    expect(rules?.prefetch?.[0].where.and[0].href_matches).toEqual(["/docs/intro", "/docs/api"]);
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
    expect(rules?.prefetch?.[0].where.and[0].href_matches).toEqual(["/"]);
    expect(rules?.prerender?.[0].where.and[0].href_matches).toEqual(["/heavy"]);
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

describe("speculation exclusions", () => {
  it("attaches the exclusion selectors to every emitted rule", () => {
    const resolved = resolveApp(
      defineApp({
        routes: [
          route("/", "./index.tsx", { speculation: "prefetch" }),
          route("/heavy", "./heavy.tsx", { speculation: "prerender" }),
        ],
      }),
    );
    const rules = buildSpeculationRules(resolved.routes);
    for (const rule of [...(rules?.prefetch ?? []), ...(rules?.prerender ?? [])]) {
      expect(rule.where.and[1]).toEqual(EXCLUSIONS);
    }
  });

  // [markup, id of the anchor under test, suppressed?]
  const cases: Array<[string, boolean]> = [
    ['<a id="target" href="/x"></a>', false],
    ['<a id="target" href="/x" rel="nofollow"></a>', true],
    ['<a id="target" href="/x" rel="noopener nofollow"></a>', true],
    // HTML rel keywords and the emitted attribute selector are ASCII
    // case-insensitive, so the client helper must be too.
    ['<a id="target" href="/x" rel="NOFOLLOW"></a>', true],
    // `nofollow` is a rel token, not a substring of one.
    ['<a id="target" href="/x" rel="nofollowers"></a>', false],
    ['<a id="target" href="/x" data-pracht-speculate="off"></a>', true],
    ['<nav data-pracht-speculate="off"><a id="target" href="/x"></a></nav>', true],
    ['<map><area id="target" href="/x" rel="nofollow"></map>', true],
    ['<map><area id="target" href="/x" data-pracht-speculate="off"></map>', true],
    ['<map data-pracht-speculate="off"><area id="target" href="/x"></map>', true],
    [
      '<map data-pracht-speculate="off"><area id="target" href="/x" data-pracht-speculate="on"></map>',
      false,
    ],
    // The anchor's own attribute beats an enclosing scope, both ways.
    [
      '<nav data-pracht-speculate="off"><a id="target" href="/x" data-pracht-speculate="on"></a></nav>',
      false,
    ],
    [
      '<nav data-pracht-speculate="on"><a id="target" href="/x" data-pracht-speculate="off"></a></nav>',
      true,
    ],
    // Container-level `on` cannot override an enclosing `off`: the emitted
    // CSS stays fail-closed at every nesting depth.
    [
      '<nav data-pracht-speculate="off"><div data-pracht-speculate="on"><a id="target" href="/x"></a></div></nav>',
      true,
    ],
    [
      '<nav data-pracht-speculate="on"><div data-pracht-speculate="off"><a id="target" href="/x"></a></div></nav>',
      true,
    ],
    ['<nav data-pracht-speculate="on"><a id="target" href="/x"></a></nav>', false],
    [
      '<nav data-pracht-speculate="off"><div data-pracht-speculate="on"><section data-pracht-speculate="off"><a id="target" href="/x"></a></section></div></nav>',
      true,
    ],
  ];

  for (const [markup, suppressed] of cases) {
    it(`${suppressed ? "suppresses" : "speculates"} ${markup}`, () => {
      document.body.innerHTML = markup;
      const anchor = document.getElementById("target");
      expect(anchor).not.toBeNull();
      expect(isSpeculationSuppressed(anchor as Element)).toBe(suppressed);
      // The emitted CSS selectors must reach the same verdict as the client
      // helper, or the browser and the router disagree about which links are
      // prerendered.
      expect((anchor as Element).matches(SPECULATION_EXCLUSION_SELECTORS.join(","))).toBe(
        suppressed,
      );
    });
  }
});
