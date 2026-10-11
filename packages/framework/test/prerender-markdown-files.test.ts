import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApiRoutes, route, timeRevalidate } from "../src/app.ts";
import {
  injectMarkdownAlternateLink,
  markdownFilePagePaths,
  markdownFilePath,
} from "../src/markdown-files.ts";
import { prerenderApp } from "../src/prerender.ts";
import type { ModuleRegistry } from "../src/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const LINK = (href: string) => `<link rel="alternate" type="text/markdown" href="${href}">`;

function page(markdown?: string) {
  return async () => ({
    Component: () => h("main", null, "HTML"),
    ...(markdown === undefined ? {} : { markdown }),
  });
}

describe("markdown file paths", () => {
  it("maps page paths to .md paths, the root to /index.md", () => {
    expect(markdownFilePath("/")).toBe("/index.md");
    expect(markdownFilePath("/about")).toBe("/about.md");
    expect(markdownFilePath("/docs/intro/")).toBe("/docs/intro.md");
    expect(markdownFilePath("/posts/caf%C3%A9")).toBe("/posts/caf%C3%A9.md");
  });

  it("maps .md paths back to the pages that can own them", () => {
    expect(markdownFilePagePaths("/index.md")).toEqual(["/", "/index"]);
    expect(markdownFilePagePaths("/about.md")).toEqual(["/about"]);
    expect(markdownFilePagePaths("/docs/index.md")).toEqual(["/docs/index"]);
    expect(markdownFilePagePaths("/.md")).toEqual([]);
    expect(markdownFilePagePaths("/docs/.md")).toEqual([]);
    expect(markdownFilePagePaths("/about.html")).toEqual([]);
  });

  it("marks the link as server-owned in islands-navigation documents", () => {
    const html = [
      "<!DOCTYPE html>",
      "<html>",
      "  <head>",
      '    <script data-pracht-owned type="application/json" id="pracht-nav">{}</script>',
      "  </head>",
      "  <body>",
      "</body></html>",
    ].join("\n");
    expect(injectMarkdownAlternateLink(html, "/a.md")).toContain(
      '<link data-pracht-owned rel="alternate" type="text/markdown" href="/a.md">\n  </head>',
    );
  });

  it("escapes the href", () => {
    const html = "<html><head></head><body></body></html>";
    expect(injectMarkdownAlternateLink(html, '/a"b.md')).toContain('href="/a&quot;b.md"');
  });
});

describe("prerenderApp({ markdownFiles })", () => {
  it("captures Markdown for SSG pages and links it from the HTML head", async () => {
    const app = defineApp({
      routes: [
        route("/", "./routes/home.tsx", { render: "ssg" }),
        route("/about", "./routes/about.tsx", { render: "ssg" }),
        route("/plain", "./routes/plain.tsx", { render: "ssg" }),
      ],
    });
    const pages = await prerenderApp({
      app,
      markdownFiles: true,
      registry: {
        routeModules: {
          "/src/routes/home.tsx": page("# Home\n"),
          "/src/routes/about.tsx": page("# About\n"),
          "/src/routes/plain.tsx": page(),
        },
      },
    });

    const byPath = Object.fromEntries(pages.map((entry) => [entry.path, entry]));
    expect(byPath["/"].markdownFile).toEqual({ path: "/index.md", source: "# Home\n" });
    expect(byPath["/about"].markdownFile).toEqual({ path: "/about.md", source: "# About\n" });
    expect(byPath["/plain"].markdownFile).toBeUndefined();
    expect(byPath["/"].html).toContain(LINK("/index.md"));
    expect(byPath["/about"].html).toContain(`${LINK("/about.md")}\n  </head>`);
    expect(byPath["/plain"].html).not.toContain("text/markdown");
  });

  it("is off unless requested", async () => {
    const [entry] = await prerenderApp({
      app: defineApp({ routes: [route("/about", "./routes/about.tsx", { render: "ssg" })] }),
      registry: { routeModules: { "/src/routes/about.tsx": page("# About\n") } },
    });
    expect(entry.markdown).toBe(true);
    expect(entry.markdownFile).toBeUndefined();
    expect(entry.html).not.toContain("text/markdown");
  });

  // An ISG snapshot regenerates; a static .md next to it never would.
  it("skips ISG pages", async () => {
    const [entry] = await prerenderApp({
      app: defineApp({
        routes: [
          route("/news", "./routes/news.tsx", {
            render: "isg",
            revalidate: timeRevalidate(60),
          }),
        ],
      }),
      markdownFiles: true,
      registry: { routeModules: { "/src/routes/news.tsx": page("# News\n") } },
    });
    expect(entry.markdownFile).toBeUndefined();
    expect(entry.html).not.toContain("text/markdown");
  });

  it("expands dynamic SSG routes and keeps encoded paths encoded", async () => {
    const pages = await prerenderApp({
      app: defineApp({
        routes: [route("/:locale/posts/:slug", "./routes/post.tsx", { render: "ssg" })],
      }),
      markdownFiles: true,
      registry: {
        routeModules: {
          "/src/routes/post.tsx": async () => ({
            Component: () => h("main", null, "Post"),
            getStaticPaths: () => [
              { locale: "en", slug: "hello" },
              { locale: "fr", slug: "café" },
            ],
            markdown: "# Post\n",
          }),
        },
      },
    });

    expect(pages.map((entry) => entry.markdownFile?.path)).toEqual([
      "/en/posts/hello.md",
      "/fr/posts/caf%C3%A9.md",
    ]);
    expect(pages[1].html).toContain(LINK("/fr/posts/caf%C3%A9.md"));
  });

  // Middleware that negotiates only for verified agents answers the anonymous
  // build request with HTML. Writing that as a file would publish it to
  // everyone; it must produce nothing.
  it("writes nothing when middleware withholds Markdown from the build request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry: ModuleRegistry = {
      middlewareModules: {
        "/src/middleware/agents.ts": async () => ({
          middleware: ({ request }, next) =>
            request.headers.get("x-verified-agent") === "1" &&
            request.headers.get("accept")?.includes("text/markdown")
              ? new Response("# Secret\n", {
                  headers: { "content-type": "text/markdown; charset=utf-8" },
                })
              : next(),
        }),
        "/src/middleware/redirect.ts": async () => ({
          middleware: ({ request }, next) =>
            request.headers.get("accept")?.includes("text/markdown")
              ? new Response(null, { headers: { location: "/login" }, status: 302 })
              : next(),
        }),
        "/src/middleware/public.ts": async () => ({
          middleware: ({ request }, next) =>
            request.headers.get("accept")?.includes("text/markdown")
              ? new Response("# Public\n", {
                  headers: { "content-type": "text/markdown; charset=utf-8" },
                })
              : next(),
        }),
      },
      routeModules: { "/src/routes/guide.tsx": page() },
    };
    const pages = await prerenderApp({
      app: defineApp({
        middleware: {
          agents: "./middleware/agents.ts",
          public: "./middleware/public.ts",
          redirect: "./middleware/redirect.ts",
        },
        routes: [
          route("/gated", "./routes/guide.tsx", {
            markdown: true,
            middleware: ["agents"],
            render: "ssg",
          }),
          route("/moved", "./routes/guide.tsx", {
            markdown: true,
            middleware: ["redirect"],
            render: "ssg",
          }),
          route("/open", "./routes/guide.tsx", {
            markdown: true,
            middleware: ["public"],
            render: "ssg",
          }),
        ],
      }),
      markdownFiles: true,
      registry,
    });

    const byPath = Object.fromEntries(pages.map((entry) => [entry.path, entry]));
    expect(byPath["/gated"].markdownFile).toBeUndefined();
    expect(byPath["/gated"].html).not.toContain("text/markdown");
    expect(byPath["/moved"].markdownFile).toBeUndefined();
    expect(byPath["/open"].markdownFile).toEqual({ path: "/open.md", source: "# Public\n" });
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "/moved (status 302, redirect: /login)",
    );
  });

  it("never takes a path owned by a route, another page, or an existing file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pages = await prerenderApp({
      apiRoutes: resolveApiRoutes(["/src/api/feed.md.ts"]),
      app: defineApp({
        routes: [
          // Declared first, yet the root still claims `/index.md`.
          route("/index", "./routes/md.tsx", { render: "ssg" }),
          route("/", "./routes/md.tsx", { render: "ssg" }),
          route("/readme", "./routes/md.tsx", { render: "ssg" }),
          route("/readme.md", "./routes/plain.tsx", { render: "ssr" }),
          route("/api/feed", "./routes/md.tsx", { render: "ssg" }),
          route("/public", "./routes/md.tsx", { render: "ssg" }),
          route("/blog/hello", "./routes/md.tsx", { render: "ssg" }),
          route("/blog/:slug", "./routes/plain.tsx", { render: "ssr" }),
        ],
      }),
      markdownFileExists: (path) => path === "/public.md",
      markdownFiles: true,
      registry: {
        routeModules: {
          "/src/routes/md.tsx": page("# Page\n"),
          "/src/routes/plain.tsx": page(),
        },
      },
    });

    const files = Object.fromEntries(
      pages.map((entry) => [entry.path, entry.markdownFile?.path ?? null]),
    );
    expect(files).toEqual({
      // `/` claims `/index.md` over a literal `/index` route.
      "/index": null,
      "/": "/index.md",
      // An exact page route answers `/readme.md`.
      "/readme": null,
      // An exact API route answers `/api/feed.md`.
      "/api/feed": null,
      // `public/public.md` is the author's file.
      "/public": null,
      // A dynamic route matching `/blog/hello.md` does not count.
      "/blog/hello": "/blog/hello.md",
    });
    const message = warn.mock.calls.map(([line]) => String(line)).join("\n");
    expect(message).toContain("not writing 4 Markdown files");
    expect(message).toContain('/readme.md (already the page route "/readme.md")');
    expect(message).toContain("/public.md (a file already exists there)");
  });

  // `rawContentArtifacts({ path: (d) => `${d.path}.md` })` already publishes
  // the page's Markdown at that URL: keep it, link it, and stay quiet.
  it("links a declared Markdown artifact at the path instead of replacing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [entry] = await prerenderApp({
      app: defineApp({ routes: [route("/guide", "./routes/guide.tsx", { render: "ssg" })] }),
      markdownFileExists: (path) => (path === "/guide.md" ? "markdown" : false),
      markdownFiles: true,
      registry: { routeModules: { "/src/routes/guide.tsx": page("# Guide\n") } },
    });

    expect(entry.markdownFile).toEqual({ path: "/guide.md" });
    expect(entry.html).toContain(LINK("/guide.md"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("links the .md URL under the deploy base", async () => {
    vi.stubEnv("BASE_URL", "/my-project/");
    vi.resetModules();
    const { prerenderApp: prerenderWithBase } = await import("../src/prerender.ts");
    const { defineApp: defineAppWithBase, route: routeWithBase } = await import("../src/app.ts");

    const [entry] = await prerenderWithBase({
      app: defineAppWithBase({
        routes: [routeWithBase("/about", "./routes/about.tsx", { render: "ssg" })],
      }),
      markdownFiles: true,
      registry: { routeModules: { "/src/routes/about.tsx": page("# About\n") } },
    });

    // The file path stays base-free (the client output is base-free); the
    // link is the URL a visitor requests.
    expect(entry.markdownFile?.path).toBe("/about.md");
    expect(entry.html).toContain(LINK("/my-project/about.md"));
  });
});
