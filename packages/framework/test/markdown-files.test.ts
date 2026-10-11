import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  defineApp,
  group,
  handlePrachtRequest,
  resolveApiRoutes,
  resolveApp,
  route,
  timeRevalidate,
} from "../src/index.ts";
import { markdownFilePath, planMarkdownFiles } from "../src/markdown-files.ts";
import type { ModuleRegistry, PrachtApp } from "../src/types.ts";

function page(markdown?: string, extra: Record<string, unknown> = {}) {
  return async () => ({
    Component: () => h("main", null, "HTML"),
    ...(markdown === undefined ? {} : { markdown }),
    ...extra,
  });
}

const passThrough = async () => ({
  middleware: (_args: unknown, next: () => Promise<Response>) => next(),
});

function plan(
  app: PrachtApp,
  registry: ModuleRegistry,
  options: Partial<Parameters<typeof planMarkdownFiles>[0]> = {},
) {
  return planMarkdownFiles({ app: resolveApp(app), registry, ...options });
}

describe("markdownFilePath", () => {
  it("maps page paths to .md paths, the root to /index.md", () => {
    expect(markdownFilePath("/")).toBe("/index.md");
    expect(markdownFilePath("/about")).toBe("/about.md");
    expect(markdownFilePath("/docs/intro/")).toBe("/docs/intro.md");
    expect(markdownFilePath("/posts/caf%C3%A9")).toBe("/posts/caf%C3%A9.md");
  });
});

describe("planMarkdownFiles", () => {
  it("gives a file only to SSG routes with a markdown export and no middleware", async () => {
    const app = defineApp({
      middleware: { gate: "./middleware/gate.ts" },
      routes: [
        route("/", "./routes/home.tsx", { render: "ssg" }),
        route("/plain", "./routes/plain.tsx", { render: "ssg" }),
        route("/news", "./routes/news.tsx", { render: "isg", revalidate: timeRevalidate(60) }),
        route("/products/:id", "./routes/product.tsx", { markdown: true, render: "ssg" }),
        route("/gated", "./routes/gated.tsx", { middleware: ["gate"], render: "ssg" }),
        group({ middleware: ["gate"] }, [
          route("/grouped", "./routes/grouped.tsx", { render: "ssg" }),
        ]),
      ],
    });
    const result = await plan(app, {
      middlewareModules: { "/src/middleware/gate.ts": passThrough },
      routeModules: {
        "/src/routes/home.tsx": page("# Home\n"),
        "/src/routes/plain.tsx": page(),
        "/src/routes/news.tsx": page("# News\n"),
        "/src/routes/product.tsx": page(undefined, { getStaticPaths: () => [{ id: "1" }] }),
        "/src/routes/gated.tsx": page("# Gated\n"),
        "/src/routes/grouped.tsx": page("# Grouped\n"),
      },
    });

    expect(result.files).toEqual([
      { pagePath: "/", markdownPath: "/index.md", source: "# Home\n" },
    ]);
    expect(result.skipped).toEqual([
      { pagePath: "/news", reason: "ISG route" },
      { pagePath: "/products/1", reason: "`markdown: true` without a `markdown` export" },
      { pagePath: "/gated", reason: "middleware decides" },
      { pagePath: "/grouped", reason: "middleware decides" },
    ]);
  });

  it("writes exactly the body the runtime sends for Accept: text/markdown", async () => {
    const source = "# Café\n\n<b>raw</b> & `code`\r\n end";
    const app = defineApp({ routes: [route("/about", "./routes/about.tsx", { render: "ssg" })] });
    const registry = { routeModules: { "/src/routes/about.tsx": page(source) } };
    const { files } = await plan(app, registry);
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/about", { headers: { accept: "text/markdown" } }),
    });
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(files[0].source).toBe(await response.text());
  });

  it("expands getStaticPaths() when no page list is given, and only those paths", async () => {
    const app = defineApp({
      routes: [route("/blog/:slug", "./routes/post.tsx", { render: "ssg" })],
    });
    const { files } = await plan(app, {
      routeModules: {
        "/src/routes/post.tsx": page("# Post\n", {
          getStaticPaths: () => [{ slug: "hello" }, { slug: "café" }],
        }),
      },
    });
    expect(files.map((file) => file.markdownPath)).toEqual([
      "/blog/hello.md",
      "/blog/caf%C3%A9.md",
    ]);
  });

  it("never takes a path a route, page, file, or another page's file owns", async () => {
    const app = defineApp({
      routes: [
        route("/index", "./routes/doc.tsx", { render: "ssg" }),
        route("/", "./routes/doc.tsx", { render: "ssg" }),
        route("/readme", "./routes/doc.tsx", { render: "ssg" }),
        route("/README.md", "./routes/plain.tsx", { render: "ssr" }),
        route("/api/feed", "./routes/doc.tsx", { render: "ssg" }),
        route("/public", "./routes/doc.tsx", { render: "ssg" }),
        route("/free", "./routes/doc.tsx", { render: "ssg" }),
      ],
    });
    const result = await plan(
      app,
      {
        routeModules: {
          "/src/routes/doc.tsx": page("# Doc\n"),
          "/src/routes/plain.tsx": page(),
        },
      },
      {
        apiRoutes: resolveApiRoutes(["/src/api/feed.md.ts"]),
        pages: ["/index", "/", "/readme", "/api/feed", "/public", "/free"],
        fileExists: (path) => path === "/public.md",
      },
    );
    expect(result.files.map((file) => file.markdownPath)).toEqual(["/index.md", "/free.md"]);
    expect(result.files[0].pagePath).toBe("/");
    expect(result.skipped).toEqual([
      { pagePath: "/index", reason: "/index.md is taken by another page's file" },
      { pagePath: "/readme", reason: '/readme.md is taken by the page route "/README.md"' },
      { pagePath: "/api/feed", reason: '/api/feed.md is taken by the API route "/api/feed.md"' },
      { pagePath: "/public", reason: "/public.md already exists" },
    ]);
  });

  // Writing `guide.md` as a file would make `guide.md/intro.html` unwritable.
  it("leaves a path a page or route nests below to be a directory", async () => {
    const app = defineApp({
      routes: [
        route("/guide", "./routes/doc.tsx", { render: "ssg" }),
        route("/guide.md/intro", "./routes/plain.tsx", { render: "ssg" }),
        route("/docs", "./routes/doc.tsx", { render: "ssg" }),
        route("/docs.md/:slug", "./routes/plain.tsx", { render: "ssr" }),
        route("/api/items", "./routes/doc.tsx", { render: "ssg" }),
      ],
    });
    const result = await plan(
      app,
      {
        routeModules: {
          "/src/routes/doc.tsx": page("# Doc\n"),
          "/src/routes/plain.tsx": page(),
        },
      },
      { apiRoutes: resolveApiRoutes(["/src/api/items.md/[id].ts"]) },
    );
    expect(result.files).toEqual([]);
    expect(result.skipped.map((entry) => entry.pagePath)).toEqual([
      "/guide",
      "/docs",
      "/api/items",
    ]);
    expect(result.skipped[0].reason).toBe('/guide.md is taken by the page route "/guide.md/intro"');
    expect(result.skipped[1].reason).toBe('/docs.md is taken by the page route "/docs.md/:slug"');
  });

  it("leaves out a route whose getStaticPaths() throws when told to", async () => {
    const app = defineApp({
      routes: [
        route("/", "./routes/home.tsx", { render: "ssg" }),
        route("/blog/:slug", "./routes/post.tsx", { render: "ssg" }),
      ],
    });
    const registry = {
      routeModules: {
        "/src/routes/home.tsx": page("# Home\n"),
        "/src/routes/post.tsx": page("# Post\n", {
          getStaticPaths: () => {
            throw new Error("no posts");
          },
        }),
      },
    };
    await expect(plan(app, registry)).rejects.toThrow("no posts");

    const failed: string[] = [];
    const { files } = await plan(app, registry, {
      onRouteError: (route, error) => failed.push(`${route.path}: ${(error as Error).message}`),
    });
    expect(files.map((file) => file.pagePath)).toEqual(["/"]);
    expect(failed).toEqual(["/blog/:slug: no posts"]);
  });
});
