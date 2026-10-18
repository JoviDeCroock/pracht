/**
 * The endpoint's work bounds: a relative image file's query string does not
 * mint new variants, a repeated request is served from memory, and only a few
 * images are optimized at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createImageHandler, type CreateImageHandlerOptions } from "../src/node.ts";

const ORIGIN = "https://app.example";

function harness(options: CreateImageHandlerOptions = {}, encodeDelay?: () => Promise<void>) {
  const fetched: string[] = [];
  let encodes = 0;
  let inFlight = 0;
  let peak = 0;
  const fakeSharp = () => {
    const pipeline = {
      rotate: () => pipeline,
      resize: () => pipeline,
      webp: () => pipeline,
      avif: () => pipeline,
      jpeg: () => pipeline,
      png: () => pipeline,
      async toBuffer() {
        encodes += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          if (encodeDelay) await encodeDelay();
          return new Uint8Array([encodes]);
        } finally {
          inFlight -= 1;
        }
      },
    };
    return pipeline;
  };
  const handler = createImageHandler({
    localOrigin: ORIGIN,
    loadSharp: async () => fakeSharp,
    fetchImage: async (url) => {
      fetched.push(url.href);
      if (url.pathname.startsWith("/missing")) return new Response("gone", { status: 404 });
      return new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } });
    },
    // A custom fetchImage turns the cache off unless it is set explicitly.
    cache: {},
    ...options,
  });
  const get = (source: string, query = "w=640", init: RequestInit = {}, signal?: AbortSignal) =>
    handler({
      request: new Request(
        `${ORIGIN}/api/_pracht/image?url=${encodeURIComponent(source)}&${query}`,
        { headers: { accept: "image/webp" }, ...init },
      ),
      signal,
    });
  return {
    get,
    fetched,
    get encodes() {
      return encodes;
    },
    get peak() {
      return peak;
    },
  };
}

describe("createImageHandler work bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the query string from a relative image file", async () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) {
      const response = await h.get(`/hero.png?bust=${i}`);
      expect(response.status).toBe(200);
    }
    expect(h.fetched).toEqual([`${ORIGIN}/hero.png`]);
    expect(h.encodes).toBe(1);
  });

  it("keeps the query of a relative source that is not an image file", async () => {
    const h = harness();
    await h.get("/api/og?title=hello");
    await h.get("/api/og?title=world");
    expect(h.fetched).toEqual([`${ORIGIN}/api/og?title=hello`, `${ORIGIN}/api/og?title=world`]);
  });

  it("keeps the source query parameters it is told to", async () => {
    const h = harness({ sourceQueryParams: ["v"] });
    await h.get("/hero.png?v=2&bust=1");
    await h.get("/hero.png?bust=2&v=2");
    await h.get("/hero.png?v=3");
    expect(h.fetched).toEqual([`${ORIGIN}/hero.png?v=2`, `${ORIGIN}/hero.png?v=3`]);
  });

  it("serves a repeated request from memory", async () => {
    const h = harness();
    const first = await h.get("/hero.png");
    const second = await h.get("/hero.png");
    expect(h.encodes).toBe(1);
    expect(h.fetched).toHaveLength(1);
    expect(second.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array(await first.arrayBuffer()),
    );
    // A different width or quality is a different image.
    await h.get("/hero.png", "w=750");
    await h.get("/hero.png", "w=640&q=50");
    expect(h.encodes).toBe(3);
  });

  it("re-encodes every time with the cache off", async () => {
    const h = harness({ cache: false });
    await h.get("/hero.png");
    await h.get("/hero.png");
    expect(h.encodes).toBe(2);
  });

  it("does not cache when the endpoint's responses are private", async () => {
    const h = harness({ cacheControl: "private, max-age=60" });
    await h.get("/hero.png");
    await h.get("/hero.png");
    expect(h.encodes).toBe(2);
  });

  it("optimizes at most maxConcurrency images at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ cache: false, maxConcurrency: 2 }, () => gate);
    const pending = Array.from({ length: 8 }, (_, i) => h.get(`/hero-${i}.png`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.peak).toBe(2);
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
    expect(h.peak).toBe(2);
  });

  it("answers 503 once the wait queue is full", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ cache: false, maxConcurrency: 1 }, () => gate);
    const pending = Array.from({ length: 1 + 64 }, (_, i) => h.get(`/hero-${i}.png`));
    const rejected = await h.get("/one-too-many.png");
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("1");
    release();
    await Promise.all(pending);
  });

  it("rejects an invalid maxConcurrency", () => {
    expect(() => createImageHandler({ maxConcurrency: 0 })).toThrow(/maxConcurrency/);
  });

  it("treats a fragment, an escaped letter and a bare ? as the same file", async () => {
    const h = harness();
    for (const source of ["/hero.png", "/hero.png#a", "/hero.png#b", "/h%65ro.png", "/hero.png?"]) {
      expect((await h.get(source)).status).toBe(200);
    }
    expect(h.fetched).toEqual([`${ORIGIN}/hero.png`]);
    expect(h.encodes).toBe(1);
  });

  it("shares one fetch and encode between identical concurrent requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ maxConcurrency: 1 }, () => gate);
    const pending = Array.from({ length: 100 }, () => h.get("/hero.png"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual(Array(100).fill(200));
    expect(h.encodes).toBe(1);
  });

  it("keeps the cache off for a custom fetchImage unless cache is set", async () => {
    const h = harness({ cache: undefined });
    await h.get("/hero.png");
    await h.get("/hero.png");
    expect(h.encodes).toBe(2);
  });

  it("re-encodes an entry once maxAge has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness({ cache: { maxAge: 60 } });
    await h.get("/hero.png");
    vi.advanceTimersByTime(59_000);
    await h.get("/hero.png");
    expect(h.encodes).toBe(1);
    vi.advanceTimersByTime(2_000);
    await h.get("/hero.png");
    expect(h.encodes).toBe(2);
  });

  it("keeps an entry no longer than the max-age in cacheControl", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness({ cacheControl: "public, max-age=30" });
    await h.get("/hero.png");
    vi.advanceTimersByTime(31_000);
    await h.get("/hero.png");
    expect(h.encodes).toBe(2);
  });

  it("refetches every request when cacheControl allows no reuse", async () => {
    let version = 1;
    const h = harness({
      cacheControl: "public, max-age=0, must-revalidate",
      fetchImage: async () =>
        new Response(new Uint8Array([version]), { headers: { "content-type": "image/gif" } }),
    });
    const first = await h.get("/live.gif");
    version = 2;
    const second = await h.get("/live.gif");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1]));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([2]));
  });

  it("fetches a remote source exactly as spelled", async () => {
    const h = harness({ remotePatterns: [{ hostname: "cdn.example" }] });
    const response = await h.get("https://cdn.example/h%65ro.png?sig=valid#frag");
    expect(response.status).toBe(200);
    expect(h.fetched).toEqual(["https://cdn.example/h%65ro.png?sig=valid"]);
  });

  it("keeps retained source query parameters exactly as written", async () => {
    const h = harness({ cache: false, sourceQueryParams: ["token", "sig"] });
    await h.get("/private/report.png?token=a%20b&bust=1&sig=valid");
    expect(h.fetched).toEqual([`${ORIGIN}/private/report.png?token=a%20b&sig=valid`]);
  });

  it("rejects a source served by the image endpoint itself", async () => {
    const h = harness({ maxConcurrency: 1, remotePatterns: [{ hostname: "app.example" }] });
    const nested = await h.get("/api/_pracht/image?url=%2Fhero.png&w=640");
    expect(nested.status).toBe(400);
    expect(await nested.text()).toMatch(/image endpoint itself/);
    expect((await h.get(`${ORIGIN}/api/_pracht/im%61ge/?url=x`)).status).toBe(400);
    expect(h.fetched).toEqual([]);
  });

  it("refuses a redirect back to the image endpoint", async () => {
    const h = harness({
      fetchImage: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "/api/_pracht/image?url=%2Fhero.png&w=640" },
        }),
    });
    const response = await h.get("/redirect.png");
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/redirected to the image endpoint/);
  });

  it("reports the age of a cached result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness({ cacheControl: "public, max-age=30, must-revalidate" });
    expect((await h.get("/hero.png")).headers.get("age")).toBeNull();
    vi.advanceTimersByTime(29_000);
    expect((await h.get("/hero.png")).headers.get("age")).toBe("29");
  });

  it("does not let a new request join work every earlier caller abandoned", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ maxConcurrency: 1 }, () => gate);
    const controller = new AbortController();
    const abandoned = h.get("/hero.png", "w=640", {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const live = h.get("/hero.png");
    release();
    await abandoned;
    expect((await live).status).toBe(200);
    expect(h.fetched).toEqual([`${ORIGIN}/hero.png`, `${ORIGIN}/hero.png`]);
  });

  it("fetches an extensionless relative source exactly as spelled", async () => {
    const h = harness();
    await h.get("/api/r%65port?sig=valid");
    expect(h.fetched).toEqual([`${ORIGIN}/api/r%65port?sig=valid`]);
  });

  it("evicts the least recently used entry beyond maxBytes", async () => {
    // Each entry costs its body, its key and a fixed overhead: two fit, three do not.
    const h = harness({ cache: { maxBytes: 2300 } });
    await h.get("/a.png");
    await h.get("/b.png");
    await h.get("/a.png");
    await h.get("/c.png");
    expect(h.encodes).toBe(3);
    await h.get("/a.png");
    expect(h.encodes).toBe(3);
    await h.get("/b.png");
    expect(h.encodes).toBe(4);
  });

  it("answers HEAD from the cache without a body", async () => {
    const h = harness();
    await h.get("/hero.png");
    const head = await h.get("/hero.png", "w=640", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/webp");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(h.encodes).toBe(1);
  });

  it("frees the slot after an error and drops an aborted waiter from the queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ cache: false, maxConcurrency: 1 }, () => gate);
    expect((await h.get("/missing.png")).status).toBe(502);
    const holding = h.get("/hero.png");
    const controller = new AbortController();
    const queued = h.get("/queued.png", "w=640", {}, controller.signal);
    controller.abort();
    expect((await queued).status).toBe(503);
    release();
    expect((await holding).status).toBe(200);
    expect(h.fetched).not.toContain(`${ORIGIN}/queued.png`);
  });

  it("rejects invalid cache bounds", () => {
    expect(() => createImageHandler({ cache: { maxAge: Number.NaN } })).toThrow(/maxAge/);
    expect(() => createImageHandler({ cache: { maxBytes: -1 } })).toThrow(/maxBytes/);
  });
});
