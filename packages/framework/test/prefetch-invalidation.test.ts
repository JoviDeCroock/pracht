// @vitest-environment jsdom
import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../src/api-fetch.ts";
import { cacheRouteState, clearPrefetchCache, getCachedRouteState } from "../src/prefetch-cache.ts";
import { ensureCapabilityRevalidation } from "../src/runtime-capability-revalidate.ts";
import { revalidateRouteData } from "../src/runtime-revalidate.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function primePrefetchCache(): void {
  cacheRouteState("/other", Promise.resolve({ type: "data", data: { stale: true } }));
}

describe("every mutation path invalidates prefetched route state", () => {
  beforeEach(() => {
    clearPrefetchCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearPrefetchCache();
  });

  it("an apiFetch mutation clears it, a read keeps it", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    primePrefetchCache();

    await apiFetch("/api/items" as never, { fetch: fetchImpl } as never);
    expect(getCachedRouteState("/other")).not.toBeNull();

    await apiFetch("/api/items" as never, { method: "POST", body: {}, fetch: fetchImpl } as never);
    expect(getCachedRouteState("/other")).toBeNull();
  });

  it("useRevalidate() clears it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: null })),
    );
    primePrefetchCache();

    await revalidateRouteData({
      data: null,
      params: {},
      routeId: "home",
      setData: () => {},
      url: "/",
    });

    expect(getCachedRouteState("/other")).toBeNull();
  });

  it("a settled non-read capability clears it even when it skips revalidation", () => {
    ensureCapabilityRevalidation();
    const settle = (detail: Record<string, unknown>) =>
      window.dispatchEvent(new CustomEvent(CAPABILITY_SETTLED_EVENT, { detail }));
    primePrefetchCache();

    settle({ name: "notes.search", ok: true, effect: "read" });
    settle({ name: "notes.create", ok: false, effect: "write" });
    expect(getCachedRouteState("/other")).not.toBeNull();

    settle({ name: "notes.create", ok: true, effect: "write", revalidate: false });
    expect(getCachedRouteState("/other")).toBeNull();
  });
});
