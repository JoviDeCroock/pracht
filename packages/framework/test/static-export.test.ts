import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

import { defineApp, route } from "../src/index.ts";
import { buildStaticFallbackHtml, prerenderApp } from "../src/prerender.ts";
import { buildStaticRouteStateUrl, STATIC_STATE_PREFIX } from "../src/runtime-static.ts";

describe("buildStaticRouteStateUrl", () => {
  it("maps the root path to the state index file", () => {
    expect(buildStaticRouteStateUrl("/")).toBe("/_pracht/state/index.json");
  });

  it("maps nested paths to collision-safe opaque components", () => {
    expect(buildStaticRouteStateUrl("/blog")).toBe("/_pracht/state/s-0062006c006f0067/_state.json");
    expect(buildStaticRouteStateUrl("/blog/hello")).toBe(
      "/_pracht/state/s-0062006c006f0067/s-00680065006c006c006f/_state.json",
    );
    expect(buildStaticRouteStateUrl("/docs")).not.toBe(
      buildStaticRouteStateUrl("/docs/index.json"),
    );
  });

  it("drops the query string — build-time loader data has no query variants", () => {
    expect(buildStaticRouteStateUrl("/pricing?ref=a&x=1")).toBe(
      "/_pracht/state/s-00700072006900630069006e0067/_state.json",
    );
    expect(buildStaticRouteStateUrl("/?_data=1")).toBe("/_pracht/state/index.json");
  });

  it("normalizes trailing slashes to the slashless build output path", () => {
    expect(buildStaticRouteStateUrl("/about/")).toBe(
      "/_pracht/state/s-00610062006f00750074/_state.json",
    );
    expect(buildStaticRouteStateUrl("/about///")).toBe(
      "/_pracht/state/s-00610062006f00750074/_state.json",
    );
  });

  it("canonicalizes equivalent URL segment spellings to the same state file", () => {
    const encoded = buildStaticRouteStateUrl("/posts/caf%C3%A9");
    expect(encoded).toBe(
      "/_pracht/state/s-0070006f007300740073/s-006300610066002500430033002500410039/_state.json",
    );
    expect(buildStaticRouteStateUrl("/posts/caf%c3%a9")).toBe(encoded);
    expect(buildStaticRouteStateUrl("/posts/café")).toBe(encoded);
    expect(buildStaticRouteStateUrl("/posts/caf%65")).toBe(buildStaticRouteStateUrl("/posts/cafe"));
  });

  it("splits long segments below filesystem component limits without losing identity", () => {
    const longSegment = "a".repeat(64);
    const url = buildStaticRouteStateUrl(`/${longSegment}`);
    const components = url.split("/").filter(Boolean);

    expect(components).toHaveLength(5);
    expect(components[2]).toMatch(/^s-/);
    expect(components[3]).toMatch(/^c-/);
    expect(Math.max(...components.map((component) => Buffer.byteLength(component)))).toBeLessThan(
      256,
    );
    expect(url).not.toBe(buildStaticRouteStateUrl(`/${longSegment}b`));
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
        route("/app", "./routes/app.tsx", {
          render: "spa",
          shell: "shell",
          hasLoader: false,
          hasHead: false,
        }),
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
      fontHead: { css: "", preloadLinks: [] },
    });
    // Plain JSON, not HTML-escaped — the file is parsed with response.json(),
    // exactly like the live route-state endpoint's body.
    expect(home!.routeState!).toContain("<script>alert(1)</script>");
  });

  it("captures an empty payload when loader presence is unknown (no build hints)", async () => {
    // Hand-rolled registries carry no route hints, so `hasLoader` and `hasHead`
    // are undefined and the capture stays conservative: whatever a hintless
    // client would fetch must exist. Real builds apply both hints, so routes
    // with neither loader nor head get no state file there (covered by e2e).
    const pages = await prerenderApp({ app: createStaticApp(), registry, staticExport: true });
    const plain = pages.find((page) => page.path === "/plain");
    expect(plain).toBeDefined();
    expect(JSON.parse(plain!.routeState!)).toEqual({
      fontHead: { css: "", preloadLinks: [] },
    });
  });

  it("emits no route state when the route is marked loaderless and headless", async () => {
    const app = defineApp({
      routes: [
        route("/plain", "./routes/plain.tsx", {
          render: "ssg",
          hasLoader: false,
          hasHead: false,
        }),
      ],
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

  it("prerenders loaderless SPA shells without pending route state", async () => {
    const pages = await prerenderApp({ app: createStaticApp(), registry, staticExport: true });
    const app = pages.find((page) => page.path === "/app");
    expect(app?.spa).toBe(true);
    expect(app?.html).toContain("loading");
    expect(app?.html).toContain('"pending":false');
    expect(app?.routeState).toBeUndefined();
  });

  it("does not prerender SPA routes outside staticExport mode", async () => {
    const pages = await prerenderApp({ app: createStaticApp(), registry });
    expect(pages.some((page) => page.path === "/app")).toBe(false);
    expect(pages.every((page) => page.routeState === undefined)).toBe(true);
  });

  it("fails a serverful build instead of producing empty prerender output", async () => {
    const renderError = new Error("docs transform stub is unavailable");
    const app = defineApp({
      routes: [
        route("/docs", "./routes/docs.tsx", { render: "ssg", hasLoader: true }),
        route("/account", "./routes/account.tsx", { render: "ssr" }),
      ],
    });
    const brokenRegistry = {
      routeModules: {
        "/src/routes/docs.tsx": async () => ({
          Component: () => h("main", null, "docs"),
          loader: () => {
            throw renderError;
          },
        }),
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(prerenderApp({ app, registry: brokenRegistry })).rejects.toMatchObject({
        cause: renderError,
        message: expect.stringMatching(
          /No SSG\/ISG pages were prerendered: all 1 attempted render returned a non-200 response.*empty prerender output/s,
        ),
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps successful output when only some serverful prerenders fail", async () => {
    const app = defineApp({
      routes: [
        route("/working", "./routes/working.tsx", { render: "ssg" }),
        route("/broken", "./routes/broken.tsx", { render: "ssg", hasLoader: true }),
      ],
    });
    const partialRegistry = {
      routeModules: {
        "/src/routes/working.tsx": async () => ({
          Component: () => h("main", null, "working"),
        }),
        "/src/routes/broken.tsx": async () => ({
          Component: () => h("main", null, "broken"),
          loader: () => {
            throw new Error("optional page data unavailable");
          },
        }),
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const pages = await prerenderApp({ app, registry: partialRegistry });
      expect(pages.map((page) => page.path)).toEqual(["/working"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("fails a static export when a build-time loader redirects", async () => {
    const app = defineApp({
      routes: [route("/old", "./routes/redirect.tsx", { render: "ssg", hasLoader: true })],
    });
    const redirectRegistry = {
      routeModules: {
        "/src/routes/redirect.tsx": async () => ({
          Component: () => h("main", null, "old"),
          loader: () => new Response(null, { headers: { location: "/new" }, status: 302 }),
        }),
      },
    };

    await expect(
      prerenderApp({ app, registry: redirectRegistry, staticExport: true }),
    ).rejects.toThrow(/document request returned status 302 \(redirect: \/new\)/);
  });

  it("fails a static export when a build-time loader errors", async () => {
    const app = defineApp({
      routes: [route("/broken", "./routes/broken.tsx", { render: "ssg", hasLoader: true })],
    });
    const brokenRegistry = {
      routeModules: {
        "/src/routes/broken.tsx": async () => ({
          Component: () => h("main", null, "broken"),
          ErrorBoundary: () => h("main", null, "caught"),
          loader: () => {
            throw new Error("build data unavailable");
          },
        }),
      },
    };

    await expect(
      prerenderApp({ app, registry: brokenRegistry, staticExport: true }),
    ).rejects.toThrow(/document request returned status 500/);
  });

  it("fails a serverful prerender when a route errors at build time", async () => {
    const app = defineApp({
      routes: [route("/broken", "./routes/broken.tsx", { render: "ssg", hasLoader: true })],
    });
    const brokenRegistry = {
      routeModules: {
        "/src/routes/broken.tsx": async () => ({
          Component: () => h("main", null, "broken"),
          ErrorBoundary: () => h("main", null, "caught"),
          loader: () => {
            throw new Error("build data unavailable");
          },
        }),
      },
    };

    // Skipping the route would ship a build whose pages fall back to a live
    // render and return the same 500 to every visitor.
    await expect(prerenderApp({ app, registry: brokenRegistry })).rejects.toThrow(
      /Failed to prerender SSG route "\/broken".*status 500/s,
    );
  });

  it("still skips a serverful prerender that a middleware gate short-circuits", async () => {
    const app = defineApp({
      middleware: { gate: "./middleware/gate.ts" },
      routes: [
        route("/open", "./routes/open.tsx", { render: "ssg" }),
        route("/gated", "./routes/gated.tsx", { middleware: ["gate"], render: "ssg" }),
      ],
    });
    const gatedRegistry = {
      middlewareModules: {
        "/src/middleware/gate.ts": async () => ({
          middleware: async () => new Response("forbidden", { status: 403 }),
        }),
      },
      routeModules: {
        "/src/routes/gated.tsx": async () => ({ Component: () => h("main", null, "gated") }),
        "/src/routes/open.tsx": async () => ({ Component: () => h("main", null, "open") }),
      },
    };

    const pages = await prerenderApp({ app, registry: gatedRegistry });
    expect(pages.map((page) => page.path)).toEqual(["/open"]);
  });

  it("names the underlying error when a build-time loader throws", async () => {
    const app = defineApp({
      routes: [route("/broken", "./routes/broken.tsx", { render: "ssg", hasLoader: true })],
    });
    const brokenRegistry = {
      routeModules: {
        "/src/routes/broken.tsx": async () => ({
          Component: () => h("main", null, "broken"),
          loader: () => {
            throw new Error("upstream CMS returned 503");
          },
        }),
      },
    };

    // The rendered 500 body deliberately hides server error details, which
    // would otherwise leave the build reporting a bare status.
    await expect(
      prerenderApp({ app, registry: brokenRegistry, staticExport: true }),
    ).rejects.toThrow(/Underlying error: upstream CMS returned 503/);
  });

  it("fails a static export when a successful document response is not HTML", async () => {
    const app = defineApp({
      routes: [route("/raw", "./routes/raw.tsx", { render: "ssg", hasLoader: true })],
    });
    const rawRegistry = {
      routeModules: {
        "/src/routes/raw.tsx": async () => ({
          Component: () => h("main", null, "unused"),
          loader: () =>
            new Response("raw body", {
              headers: { "content-type": "text/plain; charset=utf-8" },
            }),
        }),
      },
    };

    await expect(prerenderApp({ app, registry: rawRegistry, staticExport: true })).rejects.toThrow(
      /failed to render SSG route "\/raw" as HTML.*text\/plain/,
    );
  });

  it("fails a static export when route-state output is not valid JSON", async () => {
    const app = defineApp({
      routes: [route("/state", "./routes/state.tsx", { render: "ssg", hasLoader: true })],
    });
    const invalidStateRegistry = {
      routeModules: {
        "/src/routes/state.tsx": async () => ({
          Component: () => h("main", null, "state"),
          loader: ({ request }: { request: Request }) =>
            request.headers.has("x-pracht-route-state-request")
              ? new Response("not json")
              : { ok: true },
        }),
      },
    };

    await expect(
      prerenderApp({ app, registry: invalidStateRegistry, staticExport: true }),
    ).rejects.toThrow(/route-state request returned invalid JSON/);
  });

  it("fails a static export when dynamic SSG has no getStaticPaths", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx", { render: "ssg" })],
    });
    const dynamicRegistry = {
      routeModules: {
        "/src/routes/post.tsx": async () => ({ Component: () => h("main", null, "post") }),
      },
    };

    await expect(
      prerenderApp({ app, registry: dynamicRegistry, staticExport: true }),
    ).rejects.toThrow(/dynamic SSG route.*has no getStaticPaths/);
  });
});

describe("buildStaticFallbackHtml", () => {
  it("emits an empty-body document with the fallback hydration marker", () => {
    const html = buildStaticFallbackHtml({
      clientEntryUrl: "/assets/client-abc.js",
      head: {
        link: [{ href: "/favicon.svg", rel: "icon" }],
        meta: [{ content: "fallback description", name: "description" }],
        title: "Fallback title",
      },
      notFoundData: { message: "Built custom 404" },
      notFoundError: {
        message: "Not-found loader rejected the path",
        name: "PrachtHttpError",
        status: 404,
      },
    });
    expect(html).toContain('<div id="pracht-root"></div>');
    expect(html).toContain('"fallback":true');
    expect(html).toContain('"pending":true');
    expect(html).toContain('"message":"Built custom 404"');
    expect(html).toContain('"message":"Not-found loader rejected the path"');
    expect(html).toContain('"status":404');
    expect(html).toContain('src="/assets/client-abc.js"');
    expect(html).toContain("<title>Fallback title</title>");
    expect(html).toContain('content="fallback description"');
    expect(html).toContain('href="/favicon.svg"');
  });
});

describe("prerenderApp under a deploy base", () => {
  /**
   * Prerender requests are synthesized from route paths, which never carry the
   * base. They still have to reach `handlePrachtRequest` as the URL a visitor
   * would ask for: the hydration state it serializes is what the client
   * compares against `window.location` after hydration.
   */
  async function prerenderUnderBase(base: string) {
    vi.resetModules();
    vi.stubEnv("BASE_URL", base);
    const [{ defineApp: define, route: makeRoute }, { prerenderApp: prerender }] =
      await Promise.all([import("../src/index.ts"), import("../src/prerender.ts")]);

    const app = define({
      routes: [
        makeRoute("/about", "./routes/about.tsx", { render: "ssg", hasLoader: true }),
        // A route may legitimately start with the same segment as the base.
        makeRoute("/my-project/nested", "./routes/nested.tsx", { render: "ssg", hasLoader: true }),
      ],
    });
    const baseRegistry = {
      routeModules: {
        "/src/routes/about.tsx": async () => ({
          Component: () => h("main", null, "about"),
          loader: async () => ({ ok: true }),
        }),
        "/src/routes/nested.tsx": async () => ({
          Component: () => h("main", null, "nested"),
          loader: async () => ({ ok: true }),
        }),
      },
    };

    return await prerender({ app, registry: baseRegistry, staticExport: true });
  }

  it("serializes the visitor's URL while writing base-free output paths", async () => {
    const pages = await prerenderUnderBase("/my-project/");

    const about = pages.find((page) => page.path === "/about");
    expect(about).toBeDefined();
    expect(about!.html).toContain('"url":"/my-project/about"');

    // The base prefix in a route path is part of the route, not the base.
    const nested = pages.find((page) => page.path === "/my-project/nested");
    expect(nested).toBeDefined();
    expect(nested!.html).toContain('"url":"/my-project/my-project/nested"');
  });

  it("is unchanged at the origin root", async () => {
    const pages = await prerenderUnderBase("/");

    const about = pages.find((page) => page.path === "/about");
    expect(about!.html).toContain('"url":"/about"');
  });
});
