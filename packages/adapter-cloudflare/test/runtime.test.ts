import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  resolveApiRoutes,
  route,
  timeRevalidate,
  webhookRevalidate,
} from "@pracht/core";
import type { ModuleRegistry } from "@pracht/core";

import { createCloudflareFetchHandler, type CloudflareExecutionContext } from "../src/runtime.ts";

interface MockCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

function createMockCaches(): { cache: MockCache; store: Map<string, Response> } {
  const store = new Map<string, Response>();
  const cache: MockCache = {
    async match(key: Request) {
      const hit = store.get(key.url);
      return hit ? hit.clone() : undefined;
    },
    async put(key: Request, response: Response) {
      store.set(key.url, response);
    },
  };
  return { cache, store };
}

function createExecutionContext(): {
  executionContext: CloudflareExecutionContext;
  waitUntils: Promise<unknown>[];
} {
  const waitUntils: Promise<unknown>[] = [];
  return {
    executionContext: {
      waitUntil(promise: Promise<unknown>) {
        waitUntils.push(promise);
      },
    },
    waitUntils,
  };
}

function create404Assets() {
  return {
    fetch: async () => new Response("not found", { status: 404 }),
  };
}

function createPricingApp(renderCounter?: { count: number }, failLoader = false, markdown = false) {
  const app = defineApp({
    routes: [
      route("/pricing", "./routes/pricing.tsx", {
        render: "isg",
        revalidate: [timeRevalidate(1), webhookRevalidate()],
      }),
    ],
  });
  const registry: ModuleRegistry = {
    routeModules: {
      "./routes/pricing.tsx": async () => ({
        Component: ({ data }) => `regenerated:${(data as { stamp: string }).stamp}`,
        ...(markdown ? { markdown: "# Pricing\n" } : {}),
        loader: async () => {
          if (renderCounter) renderCounter.count += 1;
          if (failLoader) throw new Error("upstream CMS exploded");
          return { stamp: "fresh-content" };
        },
      }),
    },
  };
  return { app, registry };
}

function cacheKeyUrl(pathname: string, host: string): string {
  return `https://${host}${pathname}`;
}

function putCachedISGPage(
  store: Map<string, Response>,
  url: string,
  html: string,
  generatedAt: number,
): void {
  store.set(
    url,
    new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-pracht-isg-generated-at": String(generatedAt),
      },
    }),
  );
}

const isgRevalidate = [timeRevalidate(1), webhookRevalidate()] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("createCloudflareFetchHandler under a deploy base", () => {
  it("redirects the bare base before consulting the asset binding", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createCloudflareFetchHandler: createBaseHandler } = await import("../src/runtime.ts");
    const fetchAsset = vi.fn(async () => new Response("asset"));
    const handler = createBaseHandler({ app: defineApp({ routes: [] }) });
    const { executionContext } = createExecutionContext();

    const response = await handler(
      new Request("https://example.com/app?ref=campaign"),
      { ASSETS: { fetch: fetchAsset } },
      executionContext,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/app/?ref=campaign");
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("serves the base-free asset key while preserving the public request contract", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createCloudflareFetchHandler: createBaseHandler } = await import("../src/runtime.ts");
    const seenAssetPaths: string[] = [];
    const handler = createBaseHandler({ app: defineApp({ routes: [] }) });
    const { executionContext } = createExecutionContext();

    const response = await handler(
      new Request("https://example.com/app/assets/client.js"),
      {
        ASSETS: {
          async fetch(request: Request) {
            const pathname = new URL(request.url).pathname;
            seenAssetPaths.push(pathname);
            return pathname === "/assets/client.js"
              ? new Response("export default 1", {
                  headers: { "content-type": "application/javascript" },
                })
              : new Response("not found", { status: 404 });
          },
        },
      },
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export default 1");
    expect(seenAssetPaths).toEqual(["/assets/client.js"]);
  });

  it("restores the deploy base on root-absolute asset redirects", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createCloudflareFetchHandler: createBaseHandler } = await import("../src/runtime.ts");
    const handler = createBaseHandler({ app: defineApp({ routes: [] }) });
    const { executionContext } = createExecutionContext();

    const response = await handler(
      new Request("https://example.com/app/guide"),
      {
        ASSETS: {
          async fetch(request: Request) {
            expect(new URL(request.url).pathname).toBe("/guide");
            return new Response(null, { status: 307, headers: { location: "/guide/" } });
          },
        },
      },
      executionContext,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/app/guide/");
  });

  it("preserves redirects already based by the development asset binding", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createCloudflareFetchHandler: createBaseHandler } = await import("../src/runtime.ts");
    const handler = createBaseHandler({
      app: defineApp({ routes: [] }),
      assetsBindingUsesPublicBase: true,
    });
    const { executionContext } = createExecutionContext();

    const response = await handler(
      new Request("https://example.com/app/guide"),
      {
        ASSETS: {
          async fetch(request: Request) {
            expect(new URL(request.url).pathname).toBe("/guide");
            return new Response(null, { status: 302, headers: { location: "/app/guide/" } });
          },
        },
      },
      executionContext,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/guide/");
  });

  it("ignores development asset redirects back to the current public URL", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createCloudflareFetchHandler: createBaseHandler } = await import("../src/runtime.ts");
    const handler = createBaseHandler({
      app: defineApp({ routes: [] }),
      assetsBindingUsesPublicBase: true,
    });
    const { executionContext } = createExecutionContext();

    const response = await handler(
      new Request("https://example.com/app/"),
      {
        ASSETS: {
          async fetch() {
            return new Response(null, { status: 302, headers: { location: "/app/" } });
          },
        },
      },
      executionContext,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("createCloudflareFetchHandler ISG", () => {
  it("serves fresh cached ISG HTML without scheduling regeneration", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext, waitUntils } = createExecutionContext();
    const host = "fresh.example";
    putCachedISGPage(store, cacheKeyUrl("/pricing", host), "<html>cached</html>", Date.now());

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      new Request(`https://${host}/pricing`),
      { ASSETS: create404Assets() },
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-pracht-isg")).toBe("fresh");
    expect(response.headers.get("vary")).toContain("x-pracht-route-state-request");
    await expect(response.text()).resolves.toContain("cached");
    expect(waitUntils).toHaveLength(0);
  });

  it("serves stale cached HTML immediately and regenerates in the background", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext, waitUntils } = createExecutionContext();
    const host = "stale.example";
    const keyUrl = cacheKeyUrl("/pricing", host);
    putCachedISGPage(store, keyUrl, "<html>stale-copy</html>", Date.now() - 10_000);

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      new Request(`https://${host}/pricing`),
      { ASSETS: create404Assets() },
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-pracht-isg")).toBe("stale");
    await expect(response.text()).resolves.toContain("stale-copy");

    expect(waitUntils).toHaveLength(1);
    await Promise.all(waitUntils);

    const updated = store.get(keyUrl);
    expect(updated).toBeDefined();
    await expect(updated!.clone().text()).resolves.toContain("fresh-content");
    expect(updated!.headers.get("vary")).toContain("x-pracht-route-state-request");
    expect(Number(updated!.headers.get("x-pracht-isg-generated-at"))).toBeGreaterThan(
      Date.now() - 5_000,
    );
  });

  it("keeps the stale copy when background regeneration fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext, waitUntils } = createExecutionContext();
    const host = "broken.example";
    const keyUrl = cacheKeyUrl("/pricing", host);
    putCachedISGPage(store, keyUrl, "<html>stale-but-safe</html>", Date.now() - 10_000);

    const { app, registry } = createPricingApp(undefined, true);
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      new Request(`https://${host}/pricing`),
      { ASSETS: create404Assets() },
      executionContext,
    );

    expect(response.headers.get("x-pracht-isg")).toBe("stale");
    // The waitUntil promise must resolve (not reject) so workerd doesn't log
    // an unhandled rejection; the stale cache entry stays live.
    await expect(Promise.all(waitUntils)).resolves.toBeDefined();
    await expect(store.get(keyUrl)!.clone().text()).resolves.toContain("stale-but-safe");
  });

  it("collapses a stampede of stale requests into a single regeneration", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext, waitUntils } = createExecutionContext();
    const host = "stampede.example";
    const keyUrl = cacheKeyUrl("/pricing", host);
    putCachedISGPage(store, keyUrl, "<html>stale-copy</html>", Date.now() - 10_000);

    const renderCounter = { count: 0 };
    const { app, registry } = createPricingApp(renderCounter);
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const env = { ASSETS: create404Assets() };
    await Promise.all([
      handler(new Request(`https://${host}/pricing`), env, executionContext),
      handler(new Request(`https://${host}/pricing`), env, executionContext),
      handler(new Request(`https://${host}/pricing`), env, executionContext),
    ]);

    expect(waitUntils.length).toBeGreaterThan(0);
    await Promise.all(waitUntils);

    expect(renderCounter.count).toBe(1);
    await expect(store.get(keyUrl)!.clone().text()).resolves.toContain("fresh-content");
  });

  it("falls back to env.ASSETS when the Cache API has no entry", async () => {
    const { cache } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext, waitUntils } = createExecutionContext();

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: {
        "/pricing": { generatedAt: Date.now(), revalidate: isgRevalidate },
      },
    });

    const response = await handler(
      new Request("https://assets.example/pricing"),
      {
        ASSETS: {
          fetch: async () =>
            new Response("<html>build-time</html>", {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
        },
      },
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-pracht-isg")).toBe("fresh");
    await expect(response.text()).resolves.toContain("build-time");
    expect(waitUntils).toHaveLength(0);
  });

  it("bypasses the ISG cache for route-state requests", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "route-state.example";
    putCachedISGPage(store, cacheKeyUrl("/pricing", host), "<html>cached</html>", Date.now());

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      new Request(`https://${host}/pricing`, {
        headers: { "x-pracht-route-state-request": "1" },
      }),
      { ASSETS: create404Assets() },
      executionContext,
    );

    const body = await response.text();
    expect(body).not.toContain("cached");
    expect(body).toContain("fresh-content");
  });

  it("sanitizes cold Workers Caching renders before they reach app code", async () => {
    const { executionContext } = createExecutionContext();
    let contextRequest: Request | undefined;
    let loaderRequest: Request | undefined;
    const app = defineApp({
      routes: [
        route("/pricing", "./routes/pricing.tsx", {
          render: "isg",
          revalidate: timeRevalidate(60),
        }),
      ],
    });
    const registry: ModuleRegistry = {
      routeModules: {
        "./routes/pricing.tsx": async () => ({
          Component: () => "anonymous pricing",
          loader: ({ request }) => {
            loaderRequest = request;
            return null;
          },
        }),
      },
    };
    const handler = createCloudflareFetchHandler({
      app,
      cache: true,
      createContext({ request }) {
        contextRequest = request;
        return {};
      },
      registry,
    });

    const response = await handler(
      new Request("https://cache.example/pricing?campaign=visitor", {
        headers: {
          authorization: "Bearer visitor-token",
          cookie: "session=visitor-session",
        },
      }),
      { ASSETS: create404Assets() },
      executionContext,
    );

    for (const request of [contextRequest, loaderRequest]) {
      expect(request?.url).toBe("https://cache.example/pricing");
      expect(request?.method).toBe("GET");
      expect(Object.fromEntries(request?.headers ?? new Headers())).toEqual({
        accept: "text/html",
      });
    }
    expect(response.headers.get("cloudflare-cdn-cache-control")).toContain("max-age=60");
    await expect(response.text()).resolves.toContain("anonymous pricing");
  });

  it("preserves the canonical markdown cache variant while sanitizing it", async () => {
    const { executionContext } = createExecutionContext();
    let loaderRequest: Request | undefined;
    const app = defineApp({
      routes: [
        route("/pricing", "./routes/pricing.tsx", {
          render: "isg",
          revalidate: timeRevalidate(60),
        }),
      ],
    });
    const registry: ModuleRegistry = {
      routeModules: {
        "./routes/pricing.tsx": async () => ({
          Component: () => "html pricing",
          loader: ({ request }) => {
            loaderRequest = request;
            return null;
          },
          markdown: "# Markdown pricing",
        }),
      },
    };
    const handler = createCloudflareFetchHandler({ app, cache: true, registry });

    const response = await handler(
      new Request("https://cache.example/pricing?campaign=visitor", {
        headers: {
          accept: "text/html;q=0.5, text/markdown;q=0.9",
          cookie: "session=visitor-session",
        },
      }),
      { ASSETS: create404Assets() },
      executionContext,
    );

    expect(loaderRequest?.url).toBe("https://cache.example/pricing");
    expect(Object.fromEntries(loaderRequest?.headers ?? new Headers())).toEqual({
      accept: "text/markdown",
    });
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toContain("max-age=60");
    await expect(response.text()).resolves.toBe("# Markdown pricing");
  });

  it("keeps serving cached ISG HTML when only user headers vary on Accept", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "markdown.example";
    putCachedISGPage(store, cacheKeyUrl("/pricing", host), "<html>cached</html>", Date.now());

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
      headersManifest: { "/pricing": { vary: "Accept" } },
      markdownManifest: {},
    });

    // Markdown-preferring agent traffic must not push a route that ships no
    // markdown off the edge cache.
    const response = await handler(
      new Request(`https://${host}/pricing`, { headers: { accept: "text/markdown" } }),
      { ASSETS: create404Assets() },
      executionContext,
    );

    await expect(response.text()).resolves.toContain("cached");
  });

  it("bypasses the ISG cache for markdown-capable routes", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "markdown-route.example";
    putCachedISGPage(store, cacheKeyUrl("/pricing", host), "<html>cached</html>", Date.now());

    const { app, registry } = createPricingApp(undefined, false, true);
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
      headersManifest: { "/pricing": { vary: "x-pracht-route-state-request, Accept" } },
      markdownManifest: { "/pricing": true },
    });

    const response = await handler(
      new Request(`https://${host}/pricing`, { headers: { accept: "text/markdown" } }),
      { ASSETS: create404Assets() },
      executionContext,
    );

    await expect(response.text()).resolves.toBe("# Pricing\n");
  });

  it("preserves markdown negotiation when the optional manifest is unavailable", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "markdown-fallback.example";
    putCachedISGPage(store, cacheKeyUrl("/pricing", host), "<html>cached</html>", Date.now());

    const { app, registry } = createPricingApp(undefined, false, true);
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      new Request(`https://${host}/pricing`, { headers: { accept: "text/markdown" } }),
      { ASSETS: create404Assets() },
      executionContext,
    );

    await expect(response.text()).resolves.toBe("# Pricing\n");
  });
});

describe("createCloudflareFetchHandler webhook revalidation", () => {
  function createWebhookRequest(host: string, paths: string[], token?: string): Request {
    return new Request(`https://${host}/__pracht/revalidate`, {
      body: JSON.stringify({ paths }),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      method: "POST",
    });
  }

  it("fails closed without a configured token and rejects wrong tokens", async () => {
    const { cache } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const missing = await handler(
      createWebhookRequest("hook.example", ["/pricing"], "secret"),
      { ASSETS: create404Assets() },
      executionContext,
    );
    expect(missing.status).toBe(401);

    const wrong = await handler(
      createWebhookRequest("hook.example", ["/pricing"], "wrong"),
      { ASSETS: create404Assets(), PRACHT_REVALIDATE_TOKEN: "secret" },
      executionContext,
    );
    expect(wrong.status).toBe(401);
  });

  it("overwrites the Cache API entry for opted-in paths and skips the rest", async () => {
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "hook-ok.example";
    const keyUrl = cacheKeyUrl("/pricing", host);
    putCachedISGPage(store, keyUrl, "<html>old</html>", Date.now() - 10_000);

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      createWebhookRequest(host, ["/pricing", "/not-isg"], "secret"),
      { ASSETS: create404Assets(), PRACHT_REVALIDATE_TOKEN: "secret" },
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      details: [
        { outcome: "revalidated", path: "/pricing" },
        // Not in the ISG manifest: nothing cached for the webhook to refresh.
        { outcome: "skipped", path: "/not-isg", reason: "not_a_route" },
      ],
      failed: [],
      revalidated: ["/pricing"],
      skipped: ["/not-isg"],
    });
    await expect(store.get(keyUrl)!.clone().text()).resolves.toContain("fresh-content");
  });

  it("isolates malformed manifest metadata to one webhook path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "hook-malformed.example";
    const keyUrl = cacheKeyUrl("/pricing", host);
    putCachedISGPage(store, keyUrl, "<html>old</html>", Date.now() - 10_000);

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: {
        "/malformed": { revalidate: { kind: "cms" } as never },
        "/pricing": { revalidate: isgRevalidate },
      },
    });

    const response = await handler(
      createWebhookRequest(host, ["/malformed", "/pricing"], "secret"),
      { ASSETS: create404Assets(), PRACHT_REVALIDATE_TOKEN: "secret" },
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: ["/malformed"],
      revalidated: ["/pricing"],
      skipped: [],
    });
    await expect(store.get(keyUrl)!.clone().text()).resolves.toContain("fresh-content");
  });

  it("reports failed regenerations and keeps the cached copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cache, store } = createMockCaches();
    vi.stubGlobal("caches", { default: cache });
    const { executionContext } = createExecutionContext();
    const host = "hook-fail.example";
    const keyUrl = cacheKeyUrl("/pricing", host);
    putCachedISGPage(store, keyUrl, "<html>old-but-live</html>", Date.now() - 10_000);

    const { app, registry } = createPricingApp(undefined, true);
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      createWebhookRequest(host, ["/pricing"], "secret"),
      { ASSETS: create404Assets(), PRACHT_REVALIDATE_TOKEN: "secret" },
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: ["/pricing"],
      revalidated: [],
      skipped: [],
    });
    await expect(store.get(keyUrl)!.clone().text()).resolves.toContain("old-but-live");
  });

  it("returns 503 when the Cache API is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    const { executionContext } = createExecutionContext();

    const { app, registry } = createPricingApp();
    const handler = createCloudflareFetchHandler({
      app,
      registry,
      isgManifest: { "/pricing": { revalidate: isgRevalidate } },
    });

    const response = await handler(
      createWebhookRequest("no-cache.example", ["/pricing"], "secret"),
      { ASSETS: create404Assets(), PRACHT_REVALIDATE_TOKEN: "secret" },
      executionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      failed: [],
      revalidated: [],
      skipped: ["/pricing"],
    });
  });

  it("purges the public Workers Caching path under a deploy base", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const purge = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/cache.ts", async () => ({
      ...(await vi.importActual<typeof import("../src/cache.ts")>("../src/cache.ts")),
      purgeCache: purge,
    }));

    try {
      const { createCloudflareFetchHandler: createBaseHandler } = await import("../src/runtime.ts");
      const { cache } = createMockCaches();
      vi.stubGlobal("caches", { default: cache });
      const { executionContext } = createExecutionContext();
      const { app, registry } = createPricingApp();
      const handler = createBaseHandler({
        app,
        registry,
        cache: true,
        isgManifest: { "/pricing": { revalidate: isgRevalidate } },
      });

      const response = await handler(
        new Request("https://hook.example/app/__pracht/revalidate", {
          body: JSON.stringify({ paths: ["/pricing"] }),
          headers: {
            authorization: "Bearer secret",
            "content-type": "application/json",
          },
          method: "POST",
        }),
        { ASSETS: create404Assets(), PRACHT_REVALIDATE_TOKEN: "secret" },
        executionContext,
      );

      expect(response.status).toBe(200);
      expect(purge).toHaveBeenCalledWith({ pathPrefixes: ["/app/pricing"] });
    } finally {
      vi.doUnmock("../src/cache.ts");
    }
  });
});

describe("WebSocket upgrades", () => {
  /**
   * Stand in for the handshake a Durable Object returns. workerd's
   * `WebSocketPair` is unavailable under vitest and undici's Response
   * constructor rejects status 101, so shadow the two properties the adapter
   * and framework read.
   */
  function createUpgradeResponse(): Response {
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "status", { value: 101 });
    Object.defineProperty(response, "webSocket", { value: { accept() {} } });
    return response;
  }

  function createChatApp(upgrade: Response) {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
    const registry: ModuleRegistry = {
      apiModules: { "/src/api/ws.ts": async () => ({ GET: async () => upgrade }) },
    };
    return { app, apiRoutes: resolveApiRoutes(["/src/api/ws.ts"]), registry, upgrade };
  }

  function createUpgradeRequest(): Request {
    return new Request("https://chat.example/api/ws", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-fetch-site": "same-origin",
      },
    });
  }

  it("returns the handshake untouched, without consulting the assets binding", async () => {
    const { executionContext } = createExecutionContext();
    const { app, apiRoutes, registry, upgrade } = createChatApp(createUpgradeResponse());
    const assetFetch = vi.fn(async () => new Response("not found", { status: 404 }));

    const handler = createCloudflareFetchHandler({ app, apiRoutes, registry });
    const response = await handler(
      createUpgradeRequest(),
      { ASSETS: { fetch: assetFetch } },
      executionContext,
    );

    // Identity: a copy would drop the `webSocket` handle and leave a socket
    // nobody holds — the failure mode this whole path guards against.
    expect(response).toBe(upgrade);
    expect(response.status).toBe(101);
    expect((response as { webSocket?: unknown }).webSocket).toBeTruthy();
    // A handshake has no static counterpart; forwarding it to the assets
    // Fetcher is a wasted subrequest per connection.
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("does not stamp Cache-Control on the handshake", async () => {
    const { executionContext } = createExecutionContext();
    const { app, apiRoutes, registry } = createChatApp(createUpgradeResponse());

    const handler = createCloudflareFetchHandler({ app, apiRoutes, registry, cache: true });
    const response = await handler(
      createUpgradeRequest(),
      { ASSETS: create404Assets() },
      executionContext,
    );

    expect(response.status).toBe(101);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("still serves assets for ordinary requests", async () => {
    const { executionContext } = createExecutionContext();
    const { app, apiRoutes, registry } = createChatApp(createUpgradeResponse());
    const assetFetch = vi.fn(async () => new Response("logo", { status: 200 }));

    const handler = createCloudflareFetchHandler({ app, apiRoutes, registry });
    const response = await handler(
      new Request("https://chat.example/logo.svg"),
      { ASSETS: { fetch: assetFetch } },
      executionContext,
    );

    expect(assetFetch).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});
