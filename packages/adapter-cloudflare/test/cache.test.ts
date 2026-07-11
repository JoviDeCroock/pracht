import { describe, expect, it } from "vitest";
import { defineApp, route, timeRevalidate } from "@pracht/core/server";
import type { ResolvedRoute } from "@pracht/core/server";

import {
  applyWorkersCacheHeaders,
  findCacheableIsgRoute,
  ISG_CACHE_TAG,
  preventHeuristicCaching,
  purgeCache,
  resolveWorkersCacheOptions,
  routeCacheTag,
} from "../src/cache.ts";

const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
    route("/pricing", "./routes/pricing.tsx", {
      id: "pricing",
      render: "isg",
      revalidate: timeRevalidate(3600),
    }),
    route("/products/:id", "./routes/products/[id].tsx", { id: "product", render: "ssr" }),
    route("/stale", "./routes/stale.tsx", { render: "isg" }),
  ],
});

const isgRoute = (): ResolvedRoute => {
  const found = findCacheableIsgRoute(app, new Request("https://example.com/pricing"));
  if (!found) throw new Error("expected /pricing to match");
  return found;
};

const cacheOptions = { staleWhileRevalidate: 31_536_000 };

describe("resolveWorkersCacheOptions", () => {
  it("is disabled for undefined and false", () => {
    expect(resolveWorkersCacheOptions(undefined)).toBeNull();
    expect(resolveWorkersCacheOptions(false)).toBeNull();
  });

  it("defaults stale-while-revalidate to a year", () => {
    expect(resolveWorkersCacheOptions(true)).toEqual({ staleWhileRevalidate: 31_536_000 });
  });

  it("accepts a custom stale window", () => {
    expect(resolveWorkersCacheOptions({ staleWhileRevalidate: 60 })).toEqual({
      staleWhileRevalidate: 60,
    });
  });

  it("falls back to the default for invalid stale windows", () => {
    expect(resolveWorkersCacheOptions({ staleWhileRevalidate: -60 })).toEqual({
      staleWhileRevalidate: 31_536_000,
    });
    expect(resolveWorkersCacheOptions({ staleWhileRevalidate: 0 })).toEqual({
      staleWhileRevalidate: 31_536_000,
    });
    expect(resolveWorkersCacheOptions({ staleWhileRevalidate: Number.NaN })).toEqual({
      staleWhileRevalidate: 31_536_000,
    });
    expect(resolveWorkersCacheOptions({ staleWhileRevalidate: Number.POSITIVE_INFINITY })).toEqual({
      staleWhileRevalidate: 31_536_000,
    });
  });

  it("floors fractional stale windows to whole seconds", () => {
    expect(resolveWorkersCacheOptions({ staleWhileRevalidate: 60.9 })).toEqual({
      staleWhileRevalidate: 60,
    });
  });
});

describe("findCacheableIsgRoute", () => {
  it("matches GET document requests for ISG routes with a revalidate window", () => {
    const found = findCacheableIsgRoute(app, new Request("https://example.com/pricing"));
    expect(found?.id).toBe("pricing");
  });

  it("ignores non-ISG routes", () => {
    expect(findCacheableIsgRoute(app, new Request("https://example.com/"))).toBeNull();
    expect(findCacheableIsgRoute(app, new Request("https://example.com/products/1"))).toBeNull();
    expect(findCacheableIsgRoute(app, new Request("https://example.com/missing"))).toBeNull();
  });

  it("ignores ISG routes without a revalidate policy", () => {
    expect(findCacheableIsgRoute(app, new Request("https://example.com/stale"))).toBeNull();
  });

  it("ignores non-GET/HEAD requests", () => {
    expect(
      findCacheableIsgRoute(app, new Request("https://example.com/pricing", { method: "POST" })),
    ).toBeNull();
  });

  it("ignores the route-state JSON transport", () => {
    expect(
      findCacheableIsgRoute(
        app,
        new Request("https://example.com/pricing", {
          headers: { "x-pracht-route-state-request": "1" },
        }),
      ),
    ).toBeNull();
    expect(
      findCacheableIsgRoute(app, new Request("https://example.com/pricing?_data=1")),
    ).toBeNull();
  });
});

describe("applyWorkersCacheHeaders", () => {
  it("stamps edge and browser cache headers and a cache tag on ISG pages", () => {
    const response = applyWorkersCacheHeaders(
      new Response("<html></html>", {
        headers: { "content-type": "text/html", vary: "x-pracht-route-state-request" },
      }),
      isgRoute(),
      cacheOptions,
    );

    // Edge directives live in cloudflare-cdn-cache-control: must-revalidate
    // or s-maxage in Cache-Control would prohibit serving stale (RFC 9111
    // §4.2.4) and disable stale-while-revalidate entirely.
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "max-age=3600, stale-while-revalidate=31536000",
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("cache-tag")).toBe(`${ISG_CACHE_TAG},pracht:route:pricing`);
    expect(response.headers.get("vary")).toBe("x-pracht-route-state-request");
  });

  it("preserves route-aware Accept variance from the core runtime", () => {
    const response = applyWorkersCacheHeaders(
      new Response("<html></html>", {
        headers: { "content-type": "text/html", vary: "Accept" },
      }),
      isgRoute(),
      cacheOptions,
    );

    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("leaves a user-set cache-control alone", () => {
    const response = applyWorkersCacheHeaders(
      new Response("<html></html>", { headers: { "cache-control": "no-store" } }),
      isgRoute(),
      cacheOptions,
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
    expect(response.headers.has("cache-tag")).toBe(false);
  });

  it("leaves a user-set cloudflare-cdn-cache-control alone", () => {
    const response = applyWorkersCacheHeaders(
      new Response("<html></html>", {
        headers: { "cloudflare-cdn-cache-control": "max-age=60" },
      }),
      isgRoute(),
      cacheOptions,
    );

    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("max-age=60");
    expect(response.headers.has("cache-control")).toBe(false);
    expect(response.headers.has("cache-tag")).toBe(false);
  });

  it("leaves non-200 responses alone", () => {
    const response = applyWorkersCacheHeaders(
      new Response("nope", { status: 404 }),
      isgRoute(),
      cacheOptions,
    );

    expect(response.headers.has("cache-control")).toBe(false);
  });

  it("never caches responses that set cookies", () => {
    const response = applyWorkersCacheHeaders(
      new Response("<html></html>", { headers: { "set-cookie": "session=1" } }),
      isgRoute(),
      cacheOptions,
    );

    expect(response.headers.has("cache-control")).toBe(false);
  });

  it("does not edge-cache responses that vary by cookie, authorization, or everything", () => {
    for (const vary of ["Cookie", "Accept, Authorization", "*"]) {
      const response = applyWorkersCacheHeaders(
        new Response("<html></html>", { headers: { vary } }),
        isgRoute(),
        cacheOptions,
      );

      expect(response.headers.has("cache-control")).toBe(false);
      expect(response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
      expect(response.headers.has("cache-tag")).toBe(false);
      expect(response.headers.get("vary")).toBe(vary);
    }
  });
});

describe("preventHeuristicCaching", () => {
  const getRequest = new Request("https://example.com/dashboard");

  it("stamps SSR-style 200 responses without cache-control", () => {
    const response = preventHeuristicCaching(
      getRequest,
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("keeps the cache headers of ISG-cacheable responses", () => {
    const stamped = applyWorkersCacheHeaders(
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      isgRoute(),
      cacheOptions,
    );
    const response = preventHeuristicCaching(new Request("https://example.com/pricing"), stamped);

    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "max-age=3600, stale-while-revalidate=31536000",
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("cache-tag")).toBe(`${ISG_CACHE_TAG},pracht:route:pricing`);
  });

  it("leaves a user-set cache-control untouched", () => {
    const response = preventHeuristicCaching(
      getRequest,
      new Response("{}", { headers: { "cache-control": "public, max-age=300" } }),
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("leaves a user-set cloudflare-cdn-cache-control untouched", () => {
    const response = preventHeuristicCaching(
      getRequest,
      new Response("{}", { headers: { "cloudflare-cdn-cache-control": "max-age=300" } }),
    );

    expect(response.headers.has("cache-control")).toBe(false);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("max-age=300");
  });

  it("ignores non-GET/HEAD requests", () => {
    const response = preventHeuristicCaching(
      new Request("https://example.com/api/echo", { method: "POST" }),
      new Response("{}"),
    );

    expect(response.headers.has("cache-control")).toBe(false);
  });

  it("stamps responses with immutable headers by copying them", () => {
    const original = new Response("<html></html>");
    Object.defineProperty(original.headers, "set", {
      value: () => {
        throw new TypeError("immutable headers");
      },
    });

    const response = preventHeuristicCaching(getRequest, original);

    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });
});

describe("routeCacheTag", () => {
  it("builds the tag pracht stamps on cached pages", () => {
    expect(routeCacheTag("pricing")).toBe("pracht:route:pricing");
  });
});

describe("purgeCache", () => {
  it("rejects empty purges", async () => {
    await expect(purgeCache({})).rejects.toThrow(/expects `tags`/);
  });

  it("rejects purgeEverything combined with tags or prefixes", async () => {
    await expect(purgeCache({ purgeEverything: true, tags: ["a"] })).rejects.toThrow(
      /cannot be combined/,
    );
  });

  it("explains that purging needs the Workers runtime when run elsewhere", async () => {
    await expect(purgeCache({ tags: ["pracht:isg"] })).rejects.toThrow(
      /Cloudflare Workers runtime/,
    );
  });
});
