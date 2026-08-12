import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, route } from "../src/index.ts";
import { buildStaticFallbackHtml, prerenderApp } from "../src/prerender.ts";
import { buildStaticRouteStateUrl, STATIC_STATE_PREFIX } from "../src/runtime-static.ts";

describe("buildStaticRouteStateUrl", () => {
  it("maps the root path to the state index file", () => {
    expect(buildStaticRouteStateUrl("/")).toBe("/_pracht/state/index.json");
  });

  it("maps nested paths with an index.json leaf so /blog and /blog/post never collide", () => {
    expect(buildStaticRouteStateUrl("/blog")).toBe("/_pracht/state/blog/index.json");
    expect(buildStaticRouteStateUrl("/blog/hello")).toBe("/_pracht/state/blog/hello/index.json");
  });

  it("drops the query string — build-time loader data has no query variants", () => {
    expect(buildStaticRouteStateUrl("/pricing?ref=a&x=1")).toBe(
      "/_pracht/state/pricing/index.json",
    );
    expect(buildStaticRouteStateUrl("/?_data=1")).toBe("/_pracht/state/index.json");
  });

  it("normalizes trailing slashes to the slashless build output path", () => {
    expect(buildStaticRouteStateUrl("/about/")).toBe("/_pracht/state/about/index.json");
    expect(buildStaticRouteStateUrl("/about///")).toBe("/_pracht/state/about/index.json");
  });

  it("preserves percent-encoded segments exactly as the build wrote them", () => {
    expect(buildStaticRouteStateUrl("/posts/caf%C3%A9")).toBe(
      "/_pracht/state/posts/caf%C3%A9/index.json",
    );
  });

  it("stays inside the state prefix", () => {
    expect(buildStaticRouteStateUrl("/a/b/c")).toMatch(new RegExp(`^${STATIC_STATE_PREFIX}/`));
  });
});

describe("prerenderApp staticExport", () => {
  function createStaticApp() {
    return defineApp({
      routes: [
        route("/", "./routes/home.tsx", { render: "ssg" }),
        route("/plain", "./routes/plain.tsx", { render: "ssg" }),
        route("/island-page", "./routes/island-page.tsx", {
          render: "ssg",
          hydration: "islands",
        }),
        route("/app", "./routes/app.tsx", { render: "spa", shell: "shell" }),
      ],
      shells: {
        shell: "./shells/shell.tsx",
      },
    });
  }

  const registry = {
    routeModules: {
      "/src/routes/home.tsx": async () => ({
        Component: ({ data }: { data: { greeting: string } }) => h("main", null, data.greeting),
        loader: async () => ({ greeting: "hi", markup: "<script>alert(1)</script>" }),
      }),
      "/src/routes/plain.tsx": async () => ({
        Component: () => h("main", null, "plain"),
      }),
      "/src/routes/island-page.tsx": async () => ({
        Component: () => h("main", null, "islands"),
        loader: async () => ({ island: true }),
      }),
      "/src/routes/app.tsx": async () => ({
        Component: () => h("main", null, "app"),
        loader: async () => ({ widgets: [1, 2, 3] }),
      }),
    },
    shellModules: {
      "/src/shells/shell.tsx": async () => ({
        Shell: ({ children }: { children?: unknown }) => h("section", null, children as never),
        Loading: () => h("p", null, "loading"),
      }),
    },
  };

  it("captures route-state JSON for SSG routes with loaders, byte-identical to the live endpoint", async () => {
    const pages = await prerenderApp({ app: createStaticApp(), registry, staticExport: true });
    const home = pages.find((page) => page.path === "/");
    expect(home?.routeState).toBeDefined();
    expect(JSON.parse(home!.routeState!)).toEqual({
      data: { greeting: "hi", markup: "<script>alert(1)</script>" },
    });
    // Plain JSON, not HTML-escaped — the file is parsed with response.json(),
    // exactly like the live route-state endpoint's body.
    expect(home!.routeState!).toContain("<script>alert(1)</script>");
  });

  it("captures an empty payload when loader presence is unknown (no build hints)", async () => {
    // Hand-rolled registries carry no route-loader hints, so `hasLoader` is
    // undefined and the capture stays conservative: whatever a hintless
    // client would fetch must exist. Real builds apply hints on both sides,
    // so loaderless routes get no state file there (covered by the e2e).
    const pages = await prerenderApp({ app: createStaticApp(), registry, staticExport: true });
    const plain = pages.find((page) => page.path === "/plain");
    expect(plain).toBeDefined();
    expect(JSON.parse(plain!.routeState!)).toEqual({});
  });

  it("emits no route state when the route is marked loaderless", async () => {
    const app = defineApp({
      routes: [route("/plain", "./routes/plain.tsx", { render: "ssg", hasLoader: false })],
    });
    const pages = await prerenderApp({ app, registry, staticExport: true });
    const plain = pages.find((page) => page.path === "/plain");
    expect(plain).toBeDefined();
    expect(plain?.routeState).toBeUndefined();
  });

  it("emits no route state for islands routes — they navigate full-document", async () => {
    const pages = await prerenderApp({ app: createStaticApp(), registry, staticExport: true });
    const islandPage = pages.find((page) => page.path === "/island-page");
    expect(islandPage).toBeDefined();
    expect(islandPage?.routeState).toBeUndefined();
  });

  it("prerenders SPA shells and captures their loader state", async () => {
    const pages = await prerenderApp({ app: createStaticApp(), registry, staticExport: true });
    const app = pages.find((page) => page.path === "/app");
    expect(app?.spa).toBe(true);
    expect(app?.html).toContain("loading");
    expect(app?.html).toContain('"pending":true');
    expect(JSON.parse(app!.routeState!)).toEqual({ data: { widgets: [1, 2, 3] } });
  });

  it("does not prerender SPA routes outside staticExport mode", async () => {
    const pages = await prerenderApp({ app: createStaticApp(), registry });
    expect(pages.some((page) => page.path === "/app")).toBe(false);
    expect(pages.every((page) => page.routeState === undefined)).toBe(true);
  });
});

describe("buildStaticFallbackHtml", () => {
  it("emits an empty-body document with the fallback hydration marker", () => {
    const html = buildStaticFallbackHtml({ clientEntryUrl: "/assets/client-abc.js" });
    expect(html).toContain('<div id="pracht-root"></div>');
    expect(html).toContain('"fallback":true');
    expect(html).toContain('"pending":true');
    expect(html).toContain('src="/assets/client-abc.js"');
  });
});
