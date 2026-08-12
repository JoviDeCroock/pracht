import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import {
  addMarkdownManifestRoute,
  bypassesPrerenderedDocument,
  classifyRouteRequest,
  markdownResponse,
  prefersMarkdown,
  routeSupportsMarkdown,
} from "../src/runtime-negotiation.ts";

describe("prefersMarkdown", () => {
  it("returns false when the header is absent or empty", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("")).toBe(false);
  });

  it("returns false for browsers sending */*", () => {
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown("text/html,*/*")).toBe(false);
  });

  it("returns true for explicit text/markdown", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
  });

  it("respects q-values", () => {
    expect(prefersMarkdown("text/html;q=0.9, text/markdown;q=1.0")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=0.5, text/html;q=0.9")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
    expect(prefersMarkdown("text/markdown;Q=0.8, text/html;q=0.7")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=2, text/html;q=0.1")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.1234, text/html;q=0.1")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.2, text/markdown;q=0.9, text/html;q=0.8")).toBe(true);
  });
});

describe("classifyRouteRequest", () => {
  it("rematches native aliases and supports a configurable home alias", () => {
    expect(classifyRouteRequest(new Request("https://example.test/guide/v10/hooks.md"))).toEqual({
      pathname: "/guide/v10/hooks",
      routeState: false,
      markdown: true,
      markdownAlias: true,
    });
    expect(
      classifyRouteRequest(new Request("https://example.test/readme.md"), {
        homeAlias: "/readme.md",
      }),
    ).toMatchObject({ pathname: "/", markdown: true, markdownAlias: true });
    expect(
      classifyRouteRequest(new Request("https://example.test/index.md"), { homeAlias: false }),
    ).toMatchObject({ pathname: "/index", markdown: true, markdownAlias: true });
  });

  it("excludes route-state transports from Markdown aliases and negotiation", () => {
    for (const request of [
      new Request("https://example.test/guide.md?_data=1", {
        headers: { accept: "text/markdown" },
      }),
      new Request("https://example.test/guide.md", {
        headers: { accept: "text/markdown", "x-pracht-route-state-request": "1" },
      }),
    ]) {
      expect(classifyRouteRequest(request)).toEqual({
        pathname: "/guide.md",
        routeState: true,
        markdown: false,
        markdownAlias: false,
      });
    }
  });
});

describe("routeSupportsMarkdown", () => {
  it("matches exact, normalized, trailing-slash, and index-document paths", () => {
    const manifest = { "/docs": true } as const;
    expect(routeSupportsMarkdown(manifest, "/docs")).toBe(true);
    expect(routeSupportsMarkdown(manifest, "/docs/")).toBe(true);
    expect(routeSupportsMarkdown(manifest, "//docs//")).toBe(true);
    expect(routeSupportsMarkdown(manifest, "/docs/index.html")).toBe(true);
  });

  it("does not infer support from unrelated routes", () => {
    expect(routeSupportsMarkdown({ "/docs": true }, "/pricing")).toBe(false);
    expect(routeSupportsMarkdown({}, "/docs")).toBe(false);
  });

  it("records and recognizes exact native aliases", () => {
    const manifest = {};
    addMarkdownManifestRoute(manifest, "/guide/v10/hooks");
    addMarkdownManifestRoute(manifest, "/");
    expect(manifest).toEqual({
      "/": true,
      "/guide/v10/hooks": true,
      "/guide/v10/hooks.md": "/guide/v10/hooks",
      "/index.md": "/",
    });
    expect(
      bypassesPrerenderedDocument(new Request("https://example.test/guide/v10/hooks.md"), manifest),
    ).toBe(true);
  });

  it("keeps canonical .md routes on their prerendered HTML fast path", () => {
    const manifest = { "/guide.md": true, "/guide.md.md": "/guide.md" } as const;
    expect(
      bypassesPrerenderedDocument(new Request("https://example.test/guide.md"), manifest),
    ).toBe(false);
    expect(
      bypassesPrerenderedDocument(
        new Request("https://example.test/guide.md", {
          headers: { accept: "text/markdown" },
        }),
        manifest,
      ),
    ).toBe(true);
  });

  it("rejects aliases that collide with canonical routes or another alias", () => {
    const canonicalCollision = {};
    addMarkdownManifestRoute(canonicalCollision, "/guide");
    expect(() => addMarkdownManifestRoute(canonicalCollision, "/guide.md")).toThrow(/collides/);

    const homeCollision = {};
    addMarkdownManifestRoute(homeCollision, "/");
    expect(() => addMarkdownManifestRoute(homeCollision, "/index")).toThrow(/ambiguous/);
  });
});

describe("markdownResponse", () => {
  it("returns markdown with Accept in Vary", () => {
    const response = markdownResponse("# hello");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept");
  });
});

describe("handlePrachtRequest markdown negotiation", () => {
  const app = defineApp({
    routes: [route("/", "./routes/home.md")],
  });

  it("returns markdown source when the client prefers it", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            markdown: "# Home\n",
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe("# Home\n");
  });

  it("still renders HTML when the client only sends */*", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            markdown: "# Home\n",
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/html,*/*" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.includes("text/html")).toBe(true);
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept");
  });

  it("falls through to HTML when the route has no markdown export", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.includes("text/html")).toBe(true);
    expect(response.headers.get("vary")?.toLowerCase()).not.toContain("accept");
  });

  it("runs loader and preserves document headers before returning markdown", async () => {
    let loaderCalls = 0;
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            markdown: "# Home\n",
            loader: () => {
              loaderCalls += 1;
              return { ok: true };
            },
            headers: () => ({
              "cache-control": "private, no-store",
              "x-route-headers": "yes",
            }),
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(loaderCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-route-headers")).toBe("yes");
    expect(await response.text()).toBe("# Home\n");
  });

  it("runs function-valued markdown after the loader with the resolved route arguments", async () => {
    let loaderCalls = 0;
    const dynamicApp = defineApp({
      routes: [route("/guide/:version/:name", "./routes/guide.tsx")],
    });
    const context = { source: "test" };
    const response = await handlePrachtRequest({
      app: dynamicApp,
      context,
      registry: {
        routeModules: {
          "./routes/guide.tsx": async () => ({
            loader: ({ params }) => {
              loaderCalls += 1;
              return { content: { source: `# ${params.name}` } };
            },
            markdown: ({ data, params, url, context: receivedContext }: any) => {
              expect(params).toEqual({ version: "v10", name: "hooks" });
              expect(url.pathname).toBe("/guide/v10/hooks.md");
              expect(receivedContext).toBe(context);
              return `${data.content.source}\n\nVersion: ${params.version}\n`;
            },
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/guide/v10/hooks.md"),
    });

    expect(loaderCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toContain("Accept");
    expect(await response.text()).toBe("# hooks\n\nVersion: v10\n");
  });

  it("preserves exact declared .md routes before native alias rematching", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/guide.md", "./routes/guide.tsx")] }),
      registry: {
        routeModules: {
          "./routes/guide.tsx": async () => ({
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/guide.md"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("reports aliases shadowed by exact SSR routes", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [
          route("/guide", "./routes/guide.tsx", { render: "ssr" }),
          route("/guide.md", "./routes/literal.tsx", { render: "ssr" }),
        ],
      }),
      registry: {
        routeModules: {
          "./routes/guide.tsx": async () => ({
            markdown: "# Guide\n",
            Component: () => null,
          }),
          "./routes/literal.tsx": async () => ({ Component: () => null }),
        },
      },
      request: new Request("http://localhost/guide.md"),
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      'Markdown alias "/guide.md" for "/guide" collides with the declared route "/guide.md".',
    );
  });

  it("uses the sole Markdown-capable route when a home alias has two route matches", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/", "./routes/home.tsx"), route("/index", "./routes/index.tsx")],
      }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({ Component: () => null }),
          "./routes/index.tsx": async () => ({
            markdown: "# Index\n",
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/index.md"),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Index\n");
  });

  it("reports an ambiguous home alias when both candidate routes export Markdown", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/", "./routes/home.tsx"), route("/index", "./routes/index.tsx")],
      }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({ markdown: "# Home\n", Component: () => null }),
          "./routes/index.tsx": async () => ({
            markdown: "# Index\n",
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/index.md"),
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/Ambiguous Markdown alias/);
  });

  it("ignores cross-site _data query parameters when classifying Markdown requests", async () => {
    const dynamicApp = defineApp({
      routes: [route("/guide", "./routes/guide.tsx")],
    });
    const registry = {
      routeModules: {
        "./routes/guide.tsx": async () => ({ markdown: "# Guide\n", Component: () => null }),
      },
    };

    for (const pathname of ["/guide?_data=1", "/guide.md?_data=1"]) {
      const response = await handlePrachtRequest({
        app: dynamicApp,
        registry,
        request: new Request(`http://localhost${pathname}`, {
          headers: { accept: "text/markdown", "sec-fetch-site": "cross-site" },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/markdown");
      expect(await response.text()).toBe("# Guide\n");
    }
  });

  it("does not expose native aliases for routes without a markdown export", async () => {
    let loaderCalls = 0;
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/guide", "./routes/guide.tsx")] }),
      registry: {
        routeModules: {
          "./routes/guide.tsx": async () => ({
            loader: () => {
              loaderCalls += 1;
              return null;
            },
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/guide.md"),
    });
    expect(response.status).toBe(404);
    expect(loaderCalls).toBe(0);
  });

  it("preserves dynamic .md path parameters when no Markdown alias exists", async () => {
    let receivedName: string | undefined;
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/files/:name", "./routes/file.tsx")] }),
      registry: {
        routeModules: {
          "./routes/file.tsx": async () => ({
            loader: ({ params }) => {
              receivedName = params.name;
              return null;
            },
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/files/readme.md"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(receivedName).toBe("readme.md");
  });

  it("renders alias module import failures through the normal route error response", async () => {
    let moduleLoads = 0;
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/guide", "./routes/guide.tsx")] }),
      debugErrors: true,
      registry: {
        routeModules: {
          "./routes/guide.tsx": async () => {
            moduleLoads += 1;
            throw new Error("broken alias module");
          },
        },
      },
      request: new Request("http://localhost/guide.md"),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("broken alias module");
    expect(moduleLoads).toBe(1);
  });
});
