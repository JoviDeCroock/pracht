// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureClient as configureBrowserClient } from "../src/browser.ts";
import { configureClient, Form } from "../src/index.ts";
import { clearPrefetchCache, getCachedRouteState } from "../src/prefetch-cache.ts";
import { prefetchRouteState } from "../src/prefetch-api.ts";
import { fetchPrachtRouteState } from "../src/runtime.ts";

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

describe("configureClient", () => {
  afterEach(() => {
    // Reset to default (global fetch) between tests.
    configureClient({ fetch: undefined });
    clearPrefetchCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes fetchPrachtRouteState through the configured fetch", async () => {
    const customFetch = vi.fn(async () => createJsonResponse({ data: { hello: "world" } }));

    configureClient({ fetch: customFetch as unknown as typeof fetch });

    const result = await fetchPrachtRouteState("/foo");

    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(customFetch).toHaveBeenCalledWith(
      "/foo",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "x-pracht-route-state-request": "1",
        }),
        redirect: "manual",
      }),
    );
    expect(result).toEqual({ type: "data", data: { hello: "world" } });
  });

  it("is exported from the browser entry", () => {
    expect(configureBrowserClient).toBe(configureClient);
  });

  it("falls back to the global fetch when no configuration is set", async () => {
    const globalFetch = vi.fn(async () => createJsonResponse({ data: 1 }));
    vi.stubGlobal("fetch", globalFetch);

    await fetchPrachtRouteState("/bar");

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it("resets to the global fetch when fetch: undefined is passed", async () => {
    const customFetch = vi.fn(async () => createJsonResponse({ data: 1 }));
    const globalFetch = vi.fn(async () => createJsonResponse({ data: 2 }));
    vi.stubGlobal("fetch", globalFetch);

    configureClient({ fetch: customFetch as unknown as typeof fetch });
    await fetchPrachtRouteState("/a");
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();

    configureClient({ fetch: undefined });
    await fetchPrachtRouteState("/b");
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards an Authorization header injected by the configured fetch to client navigation fetches", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const customFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders.push((init?.headers as Record<string, string>) ?? {});
      return createJsonResponse({ data: null });
    });

    configureClient({
      fetch: (input, init) => {
        const headers = {
          ...(init?.headers as Record<string, string> | undefined),
          Authorization: "Bearer token-123",
        };
        return customFetch(input, { ...init, headers });
      },
    });

    await fetchPrachtRouteState("/baz");

    expect(seenHeaders[0]).toMatchObject({
      Authorization: "Bearer token-123",
      "x-pracht-route-state-request": "1",
      "Cache-Control": "no-cache",
    });
  });

  it("does not cache route-state prefetches when a custom fetch is configured", async () => {
    const customFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse({ data: { token: "first" } }))
      .mockResolvedValueOnce(createJsonResponse({ data: { token: "second" } }));

    configureClient({ fetch: customFetch });

    await expect(prefetchRouteState("/account")).resolves.toEqual({
      data: { token: "first" },
      type: "data",
    });
    expect(getCachedRouteState("/account")).toBeNull();

    await expect(prefetchRouteState("/account")).resolves.toEqual({
      data: { token: "second" },
      type: "data",
    });
    expect(customFetch).toHaveBeenCalledTimes(2);
  });

  it("routes <Form> submissions through the configured fetch", async () => {
    const customFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    configureClient({ fetch: customFetch });

    const root = document.createElement("div");
    document.body.appendChild(root);

    try {
      render(
        h(
          Form,
          { action: "/api/do", method: "post" },
          h("input", { name: "x", defaultValue: "y" }),
          h("button", { type: "submit" }, "Go"),
        ),
        root,
      );

      const form = root.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // let the microtask queue settle
      await Promise.resolve();
      await Promise.resolve();

      expect(customFetch).toHaveBeenCalledTimes(1);
      const [url, init] = customFetch.mock.calls[0]!;
      expect(url).toBe("/api/do");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
    } finally {
      render(null, root);
      root.remove();
    }
  });
});
