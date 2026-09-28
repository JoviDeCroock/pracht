// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Form } from "../src/index.ts";
import { REGION_REFRESH_EVENT } from "../src/regions-shared.ts";
import { revalidateRouteData } from "../src/runtime-revalidate.ts";

// Every place route data is refreshed in place tells full-hydration regions to
// refetch — but only in apps built with regions (`__PRACHT_REGIONS__`); every
// other app compiles the announcement out.

describe("region refresh announcements", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let refreshes: number;
  const onRefresh = () => {
    refreshes += 1;
  };

  beforeEach(() => {
    refreshes = 0;
    window.addEventListener(REGION_REFRESH_EVENT, onRefresh);
    root = document.createElement("div");
    document.body.append(root);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("__PRACHT_REGIONS__", true);
  });

  afterEach(() => {
    window.removeEventListener(REGION_REFRESH_EVENT, onRefresh);
    render(null, root);
    root.remove();
    delete window.__PRACHT_NAVIGATE__;
    vi.unstubAllGlobals();
  });

  function submit(): Promise<void> {
    root
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("announces a successful <Form> submission, and not a rejected one", async () => {
    render(h(Form, { action: "/api/cart", method: "post" }), root);

    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await submit();
    expect(refreshes).toBe(1);

    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 422 }));
    await submit();
    expect(refreshes).toBe(1);
  });

  it("announces a <Form> submission that redirects back to the page", async () => {
    window.__PRACHT_NAVIGATE__ = vi.fn(async () => undefined);
    fetchSpy.mockResolvedValue(new Response(null, { status: 303, headers: { location: "/" } }));
    render(h(Form, { action: "/api/cart", method: "post" }), root);

    await submit();

    expect(window.__PRACHT_NAVIGATE__).toHaveBeenCalledOnce();
    expect(refreshes).toBe(1);
  });

  it("announces a route data revalidation once its data is committed", async () => {
    fetchSpy.mockResolvedValue(Response.json({ data: { count: 2 } }));
    const setData = vi.fn();

    await revalidateRouteData({ data: null, params: {}, routeId: "home", url: "/", setData });

    expect(setData).toHaveBeenCalledWith({ count: 2 });
    expect(refreshes).toBe(1);
  });

  it("announces nothing in an app built without regions", async () => {
    vi.stubGlobal("__PRACHT_REGIONS__", false);
    fetchSpy.mockResolvedValue(Response.json({ data: {} }));
    await revalidateRouteData({ data: null, params: {}, routeId: "home", url: "/", setData() {} });

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    render(h(Form, { action: "/api/cart", method: "post" }), root);
    await submit();

    expect(refreshes).toBe(0);
  });
});
