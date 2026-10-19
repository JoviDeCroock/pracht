import { describe, expect, it, vi } from "vitest";

import {
  captureISGSnapshot,
  decodeISGSnapshot,
  encodeISGSnapshot,
  isgCacheKeyPath,
  isISGSnapshotRejection,
  serveISGSnapshot,
  type ISGSnapshot,
} from "../src/revalidation.ts";

describe("ISG snapshots", () => {
  it("keeps the document headers and drops transfer headers and secrets", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshot = await captureISGSnapshot(
      new Response("<main>page</main>", {
        headers: {
          "cache-control": "public, max-age=60",
          "content-length": "17",
          "content-type": "text/html; charset=utf-8",
          etag: '"render"',
          "x-api-token": "secret",
          "x-robots-tag": "noindex",
        },
      }),
      { buildId: "b1", pathname: "/page", now: 1234 },
    );

    expect(snapshot).toEqual({
      html: "<main>page</main>",
      headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
      cacheControl: "public, max-age=60",
      buildId: "b1",
      generatedAt: 1234,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"x-api-token"'));
    error.mockRestore();
  });

  it("refuses non-200 and uncacheable renders without reading them", async () => {
    const notFound = await captureISGSnapshot(new Response("gone", { status: 404 }), {
      pathname: "/p",
    });
    expect(isISGSnapshotRejection(notFound) && notFound.reason).toBe("status");

    const personal = new Response("mine", { headers: { "set-cookie": "s=1" } });
    const rejected = await captureISGSnapshot(personal, { pathname: "/p" });
    expect(isISGSnapshotRejection(rejected) && rejected.reason).toBe("uncacheable");
    expect(personal.bodyUsed).toBe(false);
  });

  it("replays the render's Cache-Control, else the adapter's browser policy", async () => {
    const snapshot: ISGSnapshot = {
      html: "<p>x</p>",
      headers: { "x-robots-tag": "all" },
      cacheControl: null,
      buildId: null,
      generatedAt: 0,
    };
    const served = serveISGSnapshot(snapshot, { stale: true, browserCacheControl: "no-cache" });
    expect(served.headers.get("cache-control")).toBe("no-cache");
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("x-pracht-isg")).toBe("stale");
    await expect(served.text()).resolves.toBe("<p>x</p>");

    const own = serveISGSnapshot({ ...snapshot, cacheControl: "public, max-age=5" });
    expect(own.headers.get("cache-control")).toBe("public, max-age=5");
    expect(own.headers.has("x-pracht-isg")).toBe(false);
  });

  it("round-trips through one string and rejects anything else", () => {
    const snapshot: ISGSnapshot = {
      html: "<p>x</p>",
      headers: { a: "1" },
      cacheControl: null,
      buildId: "b",
      generatedAt: 5,
    };
    expect(decodeISGSnapshot(encodeISGSnapshot(snapshot))).toEqual(snapshot);
    expect(decodeISGSnapshot("<html>legacy</html>")).toBeNull();
    expect(decodeISGSnapshot(JSON.stringify({ ...snapshot, format: 2 }))).toBeNull();
    expect(decodeISGSnapshot(JSON.stringify({ ...snapshot, format: 1, headers: { a: 1 } }))).toBe(
      null,
    );
  });

  it("puts the build in the cache key path", () => {
    expect(isgCacheKeyPath("/pricing", "b/1")).toBe("/__pracht/isg-build/b%2F1/pricing");
    expect(isgCacheKeyPath("/pricing", undefined)).toBe("/pricing");
  });
});
