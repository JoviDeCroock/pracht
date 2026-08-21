import { describe, expect, it, vi } from "vitest";

import { buildStaticRouteStateUrl } from "../src/runtime-static.ts";
import {
  PRACHT_BASE,
  resolveBaseRedirectLocation,
  stripBase,
  stripBaseLenient,
  withBase,
} from "../src/base.ts";

/**
 * `PRACHT_BASE` reads `import.meta.env.BASE_URL`, which Vite inlines per
 * build. Under vitest that is the origin root, so a configured base is
 * exercised by re-importing the module with the env value stubbed.
 */
async function loadBase(baseUrl: string | undefined) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", baseUrl as string);
  const mod = await import("../src/base.ts");
  return mod;
}

describe("base helpers at the origin root", () => {
  it("is the identity", () => {
    expect(PRACHT_BASE).toBe("/");
    expect(withBase("/about")).toBe("/about");
    expect(withBase("/")).toBe("/");
    expect(stripBase("/about")).toBe("/about");
    expect(stripBaseLenient("/about")).toBe("/about");
    expect(resolveBaseRedirectLocation("/")).toBeNull();
  });
});

describe("base helpers under a sub-path", () => {
  it("adds and removes the base", async () => {
    const { PRACHT_BASE: base, withBase: add, stripBase: remove } = await loadBase("/my-project/");

    expect(base).toBe("/my-project/");
    expect(add("/")).toBe("/my-project/");
    expect(add("/blog/hello")).toBe("/my-project/blog/hello");

    expect(remove("/my-project/")).toBe("/");
    // The bare base is the app root as a visitor would type it.
    expect(remove("/my-project")).toBe("/");
    expect(remove("/my-project/blog/hello")).toBe("/blog/hello");
  });

  it("reports URLs outside the base as not this app", async () => {
    const { stripBase: remove, stripBaseLenient: removeLenient } = await loadBase("/my-project/");

    expect(remove("/other-app/page")).toBeNull();
    expect(remove("/")).toBeNull();
    // A near-miss prefix is still outside: /my-projectile is another app.
    expect(remove("/my-projectile/page")).toBeNull();

    // Build-time requests carry no base, so the lenient form passes them through.
    expect(removeLenient("/blog")).toBe("/blog");
  });

  it("matches equivalent percent-encoded base spellings", async () => {
    const { resolveBaseRedirectLocation: redirectBase, stripBase: remove } =
      await loadBase("/caf%C3%A9/");

    expect(remove("/caf%c3%a9/about")).toBe("/about");
    expect(remove("/caf%C3%A9")).toBe("/");
    expect(remove("/%63af%C3%A9/posts/%61")).toBe("/posts/%61");
    expect(redirectBase("/%63af%c3%a9", "?ref=campaign")).toBe("/caf%C3%A9/?ref=campaign");
    expect(redirectBase("/caf%C3%A9/")).toBeNull();
    expect(redirectBase("/caf%C3%A9/about")).toBeNull();
  });

  it("rejects malformed or separator-decoding base spellings", async () => {
    expect((await loadBase("/app%2Fadmin/")).stripBase("/app%2Fadmin/about")).toBeNull();
    expect((await loadBase("/app%5Cadmin/")).stripBase("/app%5Cadmin/about")).toBeNull();
    expect((await loadBase("/app%00admin/")).stripBase("/app%00admin/about")).toBeNull();
    expect((await loadBase("/app%7Fadmin/")).stripBase("/app%7Fadmin/about")).toBeNull();
    expect((await loadBase("/bad%escape/")).stripBase("/bad%escape/about")).toBeNull();
  });

  it("leaves relative and absolute URLs alone", async () => {
    const { withBase: add } = await loadBase("/my-project/");

    expect(add("about")).toBe("about");
    expect(add("//cdn.example.com/x.js")).toBe("//cdn.example.com/x.js");
  });

  it("normalizes missing slashes and treats a CDN base as no base", async () => {
    expect((await loadBase("my-project")).PRACHT_BASE).toBe("/my-project/");
    expect((await loadBase("/my-project")).PRACHT_BASE).toBe("/my-project/");
    expect((await loadBase("./")).PRACHT_BASE).toBe("/");
    expect((await loadBase(undefined)).PRACHT_BASE).toBe("/");
    // A CDN base relocates assets only; documents stay at the origin root, so
    // routing must not adopt it.
    expect((await loadBase("https://cdn.example.com/")).PRACHT_BASE).toBe("/");
    expect((await loadBase("//cdn.example.com/")).PRACHT_BASE).toBe("/");
  });
});

describe("buildStaticRouteStateUrl with a base", () => {
  it("keys state files by route path and serves them under the base", async () => {
    vi.resetModules();
    vi.stubEnv("BASE_URL", "/my-project/");
    const { buildStaticRouteStateUrl: build } = await import("../src/runtime-static.ts");

    // Same file the build wrote for /blog — the base only moves the deploy root.
    expect(build("/my-project/blog")).toBe(
      "/my-project/_pracht/state/s-0062006c006f0067/_state.json",
    );
    expect(build("/my-project/")).toBe("/my-project/_pracht/state/index.json");
  });

  it("is unchanged at the origin root", () => {
    expect(buildStaticRouteStateUrl("/blog")).toBe("/_pracht/state/s-0062006c006f0067/_state.json");
  });
});

describe("base-aware speculation rules", () => {
  it("matches the browser URLs emitted under the deploy base", async () => {
    vi.resetModules();
    vi.stubEnv("BASE_URL", "/my-project/");
    const [{ defineApp, resolveApp, route }, { buildSpeculationRules }] = await Promise.all([
      import("../src/app.ts"),
      import("../src/runtime-speculation.ts"),
    ]);
    const app = resolveApp(
      defineApp({
        routes: [route("/article/:slug", "./routes/article.tsx", { speculation: "prerender" })],
      }),
    );

    expect(buildSpeculationRules(app.routes)?.prerender?.[0].where.href_matches).toEqual([
      "/my-project/article/:slug",
    ]);
  });
});
