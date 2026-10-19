import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, prerenderApp, route, timeRevalidate } from "../src/index.ts";
import type { PrerenderResult } from "../src/index.ts";
import { expandHeadersManifest, getManifestHeaders, shareHeadersManifest } from "../src/server.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * One dynamic SSG route whose loader waits on `gate(slug)` when one is
 * registered for that slug, so a test can hold a page mid-render.
 */
function createBlogApp(slugs: string[], gates: Map<string, Promise<void>> = new Map()) {
  const started: string[] = [];
  const app = defineApp({
    routes: [
      route("/posts/:slug", "./routes/post.tsx", { render: "ssg" }),
      route("/live", "./routes/live.tsx", { render: "isg", revalidate: timeRevalidate(60) }),
    ],
  });
  const registry = {
    routeModules: {
      "/src/routes/post.tsx": async () => ({
        getStaticPaths: () => slugs.map((slug) => ({ slug })),
        loader: async ({ params }: { params: Record<string, string> }) => {
          started.push(params.slug);
          await gates.get(params.slug);
          return { slug: params.slug };
        },
        Component: ({ data }: { data: { slug: string } }) => h("h1", null, data.slug),
      }),
      "/src/routes/live.tsx": async () => ({
        Component: () => h("p", null, "live"),
      }),
    },
  };
  return { app, registry, started };
}

describe("prerenderApp streaming", () => {
  it("hands each page to onPage as it renders and keeps none of them", async () => {
    const { app, registry } = createBlogApp(["a", "b", "c"]);
    const seen: { path: string; html: string; index: number; isg: boolean }[] = [];
    const paths: string[][] = [];

    const result = await prerenderApp({
      app,
      registry,
      withISGManifest: true,
      onPaths: (work) => {
        expect(seen).toEqual([]);
        paths.push(work.map((item) => item.path));
      },
      onPage: (page, info) => {
        seen.push({ path: page.path, html: page.html, index: info.index, isg: Boolean(info.isg) });
      },
    });

    expect(paths).toEqual([["/posts/a", "/posts/b", "/posts/c", "/live"]]);
    expect(result.pages).toEqual([]);
    expect(seen.map((page) => [page.path, page.index, page.isg]).sort()).toEqual([
      ["/live", 3, true],
      ["/posts/a", 0, false],
      ["/posts/b", 1, false],
      ["/posts/c", 2, false],
    ]);
    expect(seen.find((page) => page.path === "/posts/b")?.html).toContain("<h1>b</h1>");
    expect(Object.keys(result.isgManifest)).toEqual(["/live"]);
  });

  it("starts the next page as soon as any page finishes instead of waiting for a batch", async () => {
    const slow = deferred();
    const { app, registry, started } = createBlogApp(
      ["slow", "b", "c", "d", "e"],
      new Map([["slow", slow.promise]]),
    );
    const rendered: string[] = [];

    const done = prerenderApp({
      app,
      registry,
      concurrency: 2,
      withISGManifest: true,
      onPage: (page) => {
        rendered.push(page.path);
      },
    });

    // With batches of two, `/posts/c` could not start until `/posts/slow`
    // finished. A pool keeps the second slot busy.
    await expect.poll(() => rendered.length, { timeout: 2000 }).toBe(5);
    expect(rendered).not.toContain("/posts/slow");
    expect(started).toEqual(["slow", "b", "c", "d", "e"]);

    slow.resolve();
    await done;
    expect(rendered).toContain("/posts/slow");
  });

  it("returns pages in render order without onPage", async () => {
    const slow = deferred();
    const { app, registry } = createBlogApp(["slow", "b", "c"], new Map([["slow", slow.promise]]));
    const done = prerenderApp({ app, registry, concurrency: 3 });
    setTimeout(slow.resolve, 20);
    const pages: PrerenderResult[] = await done;
    expect(pages.map((page) => page.path)).toEqual([
      "/posts/slow",
      "/posts/b",
      "/posts/c",
      "/live",
    ]);
  });

  it("stops starting pages after onPage fails and rethrows once in-flight pages settle", async () => {
    const { app, registry, started } = createBlogApp(["a", "b", "c", "d", "e", "f"]);
    await expect(
      prerenderApp({
        app,
        registry,
        concurrency: 1,
        onPage: (page) => {
          if (page.path === "/posts/b") throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(started).toEqual(["a", "b"]);
  });
});

describe("ISG manifest keys", () => {
  it("keys an ISG page by the spelling every adapter looks it up with", async () => {
    const app = defineApp({
      routes: [
        route("/caf%c3%a9", "./routes/cafe.tsx", {
          render: "isg",
          revalidate: timeRevalidate(60),
        }),
      ],
    });
    const registry = {
      routeModules: {
        "/src/routes/cafe.tsx": async () => ({ Component: () => h("p", null, "café") }),
      },
    };

    const result = await prerenderApp({ app, registry, withISGManifest: true });

    // Rendered under the route's own spelling, written and keyed under the canonical one.
    expect(result.pages.map((page) => page.path)).toEqual(["/caf%C3%A9"]);
    expect(result.pages[0]!.html).toContain("<p>café</p>");
    expect(Object.keys(result.isgManifest)).toEqual(["/caf%C3%A9"]);
  });
});

describe("shared headers manifest", () => {
  const html = { "content-type": "text/html; charset=utf-8", "x-pracht-shell": "public" };
  const flat = {
    "/": html,
    "/about": { ...html },
    "/feed.xml": { "content-type": "application/rss+xml" },
    "/docs": { ...html },
  };

  it("stores each distinct header set once", () => {
    const shared = shareHeadersManifest(flat);
    expect(shared).toEqual({
      version: 2,
      sets: [html, { "content-type": "application/rss+xml" }],
      paths: { "/": 0, "/about": 0, "/feed.xml": 1, "/docs": 0 },
    });
    expect(expandHeadersManifest(shared)).toEqual(flat);
    expect(expandHeadersManifest(flat)).toBe(flat);
  });

  it("answers lookups the same in either form", () => {
    const shared = shareHeadersManifest(flat);
    for (const pathname of ["/", "/about", "/about/", "/docs/index.html", "/feed.xml", "/nope"]) {
      expect(getManifestHeaders(shared, pathname)).toEqual(getManifestHeaders(flat, pathname));
    }
  });
});
