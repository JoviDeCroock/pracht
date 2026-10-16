import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `pracht({ trailingSlash })` sets `__PRACHT_TRAILING_SLASH__` in every
 * bundle; the runtime reads it once, at module load.
 */
async function loadWithPolicy(policy: "ignore" | "never" | "always", base = "/") {
  vi.resetModules();
  vi.stubGlobal("__PRACHT_TRAILING_SLASH__", policy);
  vi.stubEnv("BASE_URL", base);
  const [core, server, baseModule] = await Promise.all([
    import("../src/index.ts"),
    import("../src/server.ts"),
    import("../src/base.ts"),
  ]);
  return { core, server, base: baseModule };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const page = (label: string) => async () => ({ Component: () => h("main", null, label) });

async function createApp(policy: "ignore" | "never" | "always", base = "/") {
  const loaded = await loadWithPolicy(policy, base);
  const { core } = loaded;
  const app = core.defineApp({
    routes: [
      core.route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
      core.route("/about", "./routes/about.tsx", { id: "about", render: "ssr" }),
      core.route("/blog/:slug", "./routes/post.tsx", { id: "post", render: "ssr" }),
      core.route("/feed.xml", "./routes/feed.tsx", { id: "feed", render: "ssr" }),
      core.route("/docs/*", "./routes/docs.tsx", { id: "docs", render: "ssr" }),
    ],
  });
  const registry = {
    routeModules: {
      "/src/routes/home.tsx": page("home"),
      "/src/routes/about.tsx": page("about"),
      "/src/routes/post.tsx": page("post"),
      "/src/routes/feed.tsx": page("feed"),
      "/src/routes/docs.tsx": page("docs"),
    },
    apiModules: {
      "/src/api/hello.ts": async () => ({ GET: () => new Response("hello") }),
    },
  };
  const apiRoutes = loaded.server.resolveApiRoutes(["/src/api/hello.ts"]);
  const request = (path: string, init?: RequestInit) =>
    loaded.server.handlePrachtRequest({
      app,
      apiRoutes,
      registry,
      request: new Request(`https://example.com${path}`, init),
    });
  return { ...loaded, app, request };
}

describe("applyTrailingSlash", () => {
  it("leaves every path alone by default", async () => {
    const { base } = await loadWithPolicy("ignore");
    expect(base.applyTrailingSlash("/about")).toBe("/about");
    expect(base.applyTrailingSlash("/about/")).toBe("/about/");
  });

  it('adds the slash under "always", except to the root and file names', async () => {
    const { base } = await loadWithPolicy("always");
    expect(base.applyTrailingSlash("/")).toBe("/");
    expect(base.applyTrailingSlash("/about")).toBe("/about/");
    expect(base.applyTrailingSlash("/about/")).toBe("/about/");
    expect(base.applyTrailingSlash("/about//")).toBe("/about/");
    expect(base.applyTrailingSlash("/feed.xml")).toBe("/feed.xml");
    expect(base.applyTrailingSlash("/feed.xml/")).toBe("/feed.xml");
  });

  it('removes the slash under "never", except from the root', async () => {
    const { base } = await loadWithPolicy("never");
    expect(base.applyTrailingSlash("/")).toBe("/");
    expect(base.applyTrailingSlash("/about/")).toBe("/about");
    expect(base.applyTrailingSlash("/about//")).toBe("/about");
    expect(base.applyTrailingSlash("/about")).toBe("/about");
  });

  it("keeps the deploy base's slash, which is the root as a URL", async () => {
    const never = await loadWithPolicy("never", "/app/");
    expect(never.base.applyTrailingSlash("/app/")).toBe("/app/");
    expect(never.base.applyTrailingSlash("/app/about/")).toBe("/app/about");
    const always = await loadWithPolicy("always", "/app/");
    expect(always.base.applyTrailingSlash("/app/about")).toBe("/app/about/");
  });
});

describe('server runtime under trailingSlash: "always"', () => {
  it("redirects a page's slashless URL with a 308 that keeps the query", async () => {
    const { request } = await createApp("always");
    const response = await request("/about?ref=mail&x=1");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/about/?ref=mail&x=1");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const head = await request("/blog/hello", { method: "HEAD" });
    expect(head.status).toBe(308);
    expect(head.headers.get("location")).toBe("/blog/hello/");

    const catchAll = await request("/docs/a/b");
    expect(catchAll.headers.get("location")).toBe("/docs/a/b/");
  });

  it("serves the canonical spelling, the root, and file-named pages", async () => {
    const { request } = await createApp("always");
    expect((await request("/about/")).status).toBe(200);
    expect(await (await request("/about/")).text()).toContain("about");
    expect((await request("/")).status).toBe(200);
    expect((await request("/feed.xml")).status).toBe(200);
    const slashedFile = await request("/feed.xml/");
    expect(slashedFile.status).toBe(308);
    expect(slashedFile.headers.get("location")).toBe("/feed.xml");
  });

  it("leaves API routes, unknown URLs, route state, Markdown, and other methods alone", async () => {
    const { request } = await createApp("always");
    expect((await request("/api/hello")).status).toBe(200);
    expect((await request("/api/hello/")).status).toBe(200);
    expect((await request("/missing")).status).toBe(404);
    const state = await request("/about", { headers: { "x-pracht-route-state-request": "1" } });
    expect(state.status).toBe(200);
    expect(state.headers.get("content-type")).toContain("application/json");
    const markdown = await request("/about", { headers: { accept: "text/markdown" } });
    expect(markdown.status).not.toBe(308);
    expect((await request("/about", { method: "POST" })).status).toBe(405);
  });

  it("redirects under a deploy base without touching the bare base redirect", async () => {
    const { request } = await createApp("always", "/app/");
    const bare = await request("/app?x=1");
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe("/app/?x=1");
    expect((await request("/app/")).status).toBe(200);
    const about = await request("/app/about");
    expect(about.status).toBe(308);
    expect(about.headers.get("location")).toBe("/app/about/");
    expect((await request("/app/about/")).status).toBe(200);
  });
});

describe("redirect locations", () => {
  it("never become protocol-relative, whatever the request path", async () => {
    for (const [policy, path, location] of [
      // Already canonical: a file-named last segment keeps no slash.
      ["always", "//evil.example", null],
      ["always", "//evil", "/evil/"],
      ["never", "//evil.example/", "/evil.example"],
    ] as const) {
      const { core, server } = await loadWithPolicy(policy);
      const response = await server.handlePrachtRequest({
        app: core.defineApp({ routes: [core.route("/:slug", "./routes/slug.tsx")] }),
        registry: { routeModules: { "/src/routes/slug.tsx": page("slug") } },
        request: new Request(`https://example.com${path}`),
      });
      expect(response.headers.get("location"), `${policy} ${path}`).toBe(location);
    }
  });
});

describe('server runtime under trailingSlash: "never"', () => {
  it("redirects the slashed spelling and keeps the root", async () => {
    const { request } = await createApp("never");
    const response = await request("/about/?ref=1");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/about?ref=1");
    expect((await request("/about")).status).toBe(200);
    expect((await request("/")).status).toBe(200);
  });

  it("serves the deploy base root with its slash rather than redirecting it away", async () => {
    const { request } = await createApp("never", "/app/");
    expect((await request("/app/")).status).toBe(200);
    const about = await request("/app/about/");
    expect(about.headers.get("location")).toBe("/app/about");
  });
});

describe("the default policy", () => {
  it("answers both spellings, as before", async () => {
    const { request } = await createApp("ignore");
    expect((await request("/about")).status).toBe(200);
    expect((await request("/about/")).status).toBe(200);
  });
});

describe("generated URLs", () => {
  it("builds hrefs, redirects, and llms.txt links in the canonical spelling", async () => {
    const { app, core, server } = await createApp("always");
    const href = core.createHref(core.resolveApp(app).routes);
    expect(href("about" as never)).toBe("/about/");
    expect(href("home" as never)).toBe("/");
    expect(href("feed" as never)).toBe("/feed.xml");
    expect(
      href("post" as never, { params: { slug: "hi" }, search: { q: "1" }, hash: "top" } as never),
    ).toBe("/blog/hi/?q=1#top");

    expect(core.redirect("/about?next=1").headers.get("location")).toBe("/about/?next=1");
    expect(core.redirect("/api/logout").headers.get("location")).toBe("/api/logout");
    expect(core.redirect("https://example.org/x").headers.get("location")).toBe(
      "https://example.org/x",
    );

    const llms = await server.buildLlmsTxt({
      app: core.resolveApp(app),
      registry: {},
      title: "Test",
      include: ["pages"],
    });
    expect(llms).toContain("(/about/)");
    expect(llms).toContain("(/)");
  });

  it("prerenders each page at its canonical URL", async () => {
    const { core, server } = await loadWithPolicy("always");
    const app = core.defineApp({
      routes: [core.route("/about", "./routes/about.tsx", { id: "about", render: "ssg" })],
    });
    const pages = await server.prerenderApp({
      app,
      registry: {
        routeModules: {
          "/src/routes/about.tsx": async () => ({
            Component: () => h("main", null, core.useLocation().pathname),
          }),
        },
      },
    });
    expect(pages.map((entry: { path: string }) => entry.path)).toEqual(["/about"]);
    expect(pages[0].html).toContain("<main>/about/</main>");
  });

  it("regenerates ISG pages at their canonical URL", async () => {
    const { server } = await loadWithPolicy("always");
    expect(new URL(server.createISGRegenerationRequest("/pricing").url).pathname).toBe("/pricing/");
  });
});
