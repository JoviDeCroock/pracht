import { describe, expect, it } from "vitest";

import {
  collectDevCssUrls,
  createDevCssManifest,
  injectDevCssLinks,
  isDevNotFoundRequest,
  shouldBypassDevSSR,
} from "../src/plugin-dev-ssr.ts";

function moduleNode(url: string, type: "js" | "css" = "js", importedModules: any[] = []): any {
  return { importedModules: new Set(importedModules), type, url };
}

describe("development CSS discovery", () => {
  it("collects transitive stylesheets once", () => {
    const sharedCss = moduleNode("/src/styles/shared.css");
    const component = moduleNode("/src/components/card.tsx", "js", [
      moduleNode("/src/components/card.module.css"),
      moduleNode("/src/styles/tokens.css?raw"),
      sharedCss,
    ]);
    const entry = moduleNode("/src/routes/home.tsx", "js", [component, sharedCss]);

    expect(collectDevCssUrls(entry)).toEqual([
      "/src/components/card.module.css",
      "/src/styles/shared.css",
    ]);
  });

  it("builds a route and shell CSS manifest from Vite's SSR graph", async () => {
    const routeEntry = moduleNode("/src/routes/home.tsx", "js", [
      moduleNode("/src/routes/home.module.css", "css"),
    ]);
    const shellEntry = moduleNode("/src/shells/public.tsx", "js", [
      moduleNode("/src/styles/global.css", "css"),
    ]);
    const graph = new Map([
      ["/src/routes/home.tsx", routeEntry],
      ["/src/shells/public.tsx", shellEntry],
    ]);

    const manifest = await createDevCssManifest(
      {
        environments: {
          ssr: { moduleGraph: { getModuleByUrl: async (url: string) => graph.get(url) } },
        },
      } as any,
      {
        app: {
          routes: [],
        } as any,
        matchAppRoute: () => ({
          route: {
            file: "./routes/home.tsx",
            shellFile: "./shells/public.tsx",
          } as any,
        }),
        pathname: "/",
        registry: {
          routeModules: {
            "/src/routes/home.tsx": async () => ({}) as any,
          },
          shellModules: {
            "/src/shells/public.tsx": async () => ({}) as any,
          },
        },
      },
    );

    expect(manifest).toEqual({
      "./shells/public.tsx": ["/src/styles/global.css"],
      "./routes/home.tsx": ["/src/routes/home.module.css"],
    });
  });

  it("injects discovered styles into the document head without duplicates", () => {
    const html =
      '<html><head><link rel="stylesheet" href="/existing.css"></head><body></body></html>';

    expect(
      injectDevCssLinks(html, {
        route: ["/route.css", "/existing.css"],
        shell: ["/global.css", "/route.css"],
      }),
    ).toBe(
      '<html><head><link rel="stylesheet" href="/existing.css">    <link rel="stylesheet" href="/route.css">\n' +
        '    <link rel="stylesheet" href="/global.css">\n' +
        "  </head><body></body></html>",
    );
  });
});

const routeMatchers = {
  app: {} as any,
  apiRoutes: [] as any[],
  matchApiRoute: () => undefined,
  matchAppRoute: (_app: unknown, pathname: string) =>
    new Set(["/blog/release-1.2.3", "/blog/openapi.json", "/@alice"]).has(pathname)
      ? ({ pathname } as const)
      : undefined,
};

describe("shouldBypassDevSSR", () => {
  it("keeps dotted document routes inside framework handling", () => {
    expect(
      shouldBypassDevSSR(
        "/blog/release-1.2.3",
        {
          headers: { accept: "text/html,application/xhtml+xml" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/blog/openapi.json",
        {
          headers: { accept: "text/html,application/xhtml+xml" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/@alice",
        {
          headers: { accept: "text/html,application/xhtml+xml" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);
  });

  it("keeps route-state requests inside framework handling even for dotted slugs", () => {
    expect(
      shouldBypassDevSSR("/api/health", {
        headers: { accept: "application/json" },
        method: "GET",
      }),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/blog/openapi.json?_data=1",
        {
          headers: { accept: "*/*" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    expect(
      shouldBypassDevSSR(
        "/blog/release-1.2.3",
        {
          headers: {
            accept: "application/json",
            "x-pracht-route-state-request": "1",
          },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);
  });

  it("bypasses reserved vite internals and explicit asset fetches", () => {
    expect(
      shouldBypassDevSSR("/@vite/client", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(true);

    expect(
      shouldBypassDevSSR("/@id/preact", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(true);

    expect(
      shouldBypassDevSSR("/assets/app.js", {
        headers: { accept: "*/*", "sec-fetch-dest": "script" },
        method: "GET",
      }),
    ).toBe(true);

    expect(
      shouldBypassDevSSR("/logo.svg", {
        headers: { accept: "image/avif,image/webp,*/*", "sec-fetch-dest": "image" },
        method: "GET",
      }),
    ).toBe(true);

    // Static markdown (skill catalogs, llms.txt companions) is an asset in dev
    // too, so `pracht dev` matches what the adapters serve in production.
    expect(
      shouldBypassDevSSR("/skills/add-auth.md", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(true);
  });

  it("serves the dev 404 page for unmatched HTML navigations only", () => {
    const htmlHeaders = { accept: "text/html,application/xhtml+xml" };

    // Unmatched document navigation → rich dev 404.
    expect(
      isDevNotFoundRequest("/nope", { headers: htmlHeaders, method: "GET" }, routeMatchers),
    ).toBe(true);
    expect(
      isDevNotFoundRequest("/api/unknown", { headers: htmlHeaders, method: "GET" }, routeMatchers),
    ).toBe(true);

    // Matched routes never hit the dev 404.
    expect(
      isDevNotFoundRequest("/@alice", { headers: htmlHeaders, method: "GET" }, routeMatchers),
    ).toBe(false);

    // Route-state (JSON) requests keep their existing 404 behavior.
    expect(
      isDevNotFoundRequest(
        "/nope?_data=1",
        { headers: { accept: "*/*" }, method: "GET" },
        routeMatchers,
      ),
    ).toBe(false);
    expect(
      isDevNotFoundRequest(
        "/nope",
        {
          headers: { accept: "application/json", "x-pracht-route-state-request": "1" },
          method: "GET",
        },
        routeMatchers,
      ),
    ).toBe(false);

    // Non-document fetches and mutations keep their existing behavior.
    expect(
      isDevNotFoundRequest("/nope", { headers: { accept: "*/*" }, method: "GET" }, routeMatchers),
    ).toBe(false);
    expect(
      isDevNotFoundRequest("/nope", { headers: htmlHeaders, method: "POST" }, routeMatchers),
    ).toBe(false);
  });

  it("yields the dev 404 page to an app-declared notFound page", () => {
    const withNotFound = {
      ...routeMatchers,
      app: { notFound: { file: "./routes/not-found.tsx" } } as any,
    };

    expect(
      isDevNotFoundRequest(
        "/nope",
        { headers: { accept: "text/html,application/xhtml+xml" }, method: "GET" },
        withNotFound,
      ),
    ).toBe(false);
  });

  it("still treats unmatched HTML navigations as document requests", () => {
    expect(
      shouldBypassDevSSR("/unknown/file.json", {
        headers: { accept: "text/html,application/xhtml+xml" },
        method: "GET",
      }),
    ).toBe(false);

    expect(
      shouldBypassDevSSR("/", {
        headers: { accept: "*/*" },
        method: "GET",
      }),
    ).toBe(false);
  });
});
