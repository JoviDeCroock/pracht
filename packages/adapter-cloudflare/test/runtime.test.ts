import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, route, timeRevalidate, webhookRevalidate } from "@pracht/core";
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

function createPricingApp(renderCounter?: { count: number }, failLoader = false) {
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
  vi.restoreAllMocks();
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
      failed: [],
      revalidated: ["/pricing"],
      skipped: ["/not-isg"],
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
    await expect(response.json()).resolves.toEqual({
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
});
