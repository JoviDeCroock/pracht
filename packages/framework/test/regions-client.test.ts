// @vitest-environment jsdom
import { h, hydrate, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { swapRegions } from "../src/regions-client.ts";
import { createClientRegion } from "../src/regions-component.ts";

const FILE = "/src/regions/Visitor.tsx";

function mockFetch(respond: (url: URL, init?: RequestInit) => Response) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      calls.push({ url, init });
      return respond(url, init);
    }),
  );
  return calls;
}

/** A region endpoint fragment: status 200 and the endpoint's marker header. */
function fragment(html: string, headers: Record<string, string> = {}) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html", "x-pracht-region": "1", ...headers },
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Every Preact root a test mounted: unmounted after it, so no region keeps
// listening for refreshes into the next test.
const roots: HTMLElement[] = [];
function mountRoot(html = ""): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) render(null, root);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-pracht-regions-ready");
  history.replaceState(null, "", "/");
});

describe("swapRegions", () => {
  it("fetches each pending region for the current page and swaps its HTML in", async () => {
    history.replaceState(null, "", "/products/7?ref=home");
    document.body.innerHTML =
      `<pracht-region region="${FILE}" props='{"greeting":"Hi"}' pending><i>…</i></pracht-region>` +
      `<pracht-region region="${FILE}"><b>inline</b></pracht-region>`;
    const calls = mockFetch(() => fragment("<p>Hi, Ada</p>"));

    await swapRegions();

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/__pracht/region");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      region: FILE,
      path: "/products/7?ref=home",
      props: '{"greeting":"Hi"}',
    });
    expect(calls[0].init!.headers).toEqual({ "x-pracht-region": "1" });

    const [pending, inline] = document.querySelectorAll("pracht-region");
    expect(pending.innerHTML).toBe("<p>Hi, Ada</p>");
    expect(pending.hasAttribute("pending")).toBe(false);
    expect(inline.innerHTML).toBe("<b>inline</b>");
    expect(document.documentElement.getAttribute("data-pracht-regions-ready")).toBe("true");
  });

  it("keeps the fallback when the endpoint has no region for this visitor", async () => {
    document.body.innerHTML = `<pracht-region region="${FILE}" pending><i>fallback</i></pracht-region>`;
    mockFetch(() => new Response(null, { status: 204 }));

    await swapRegions();

    const region = document.querySelector("pracht-region")!;
    expect(region.innerHTML).toBe("<i>fallback</i>");
    expect(region.hasAttribute("pending")).toBe(true);
    expect(document.documentElement.getAttribute("data-pracht-regions-ready")).toBe("true");
  });

  it("keeps the fallback when a 200 is not the endpoint's fragment", async () => {
    // A static host answering unknown URLs with its SPA fallback document.
    document.body.innerHTML = `<pracht-region region="${FILE}" pending><i>fallback</i></pracht-region>`;
    mockFetch(
      () =>
        new Response("<!doctype html><html><body>app shell</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    await swapRegions();

    const region = document.querySelector("pracht-region")!;
    expect(region.innerHTML).toBe("<i>fallback</i>");
    expect(region.hasAttribute("pending")).toBe(true);
  });

  it("keeps the fallback when the request fails", async () => {
    document.body.innerHTML = `<pracht-region region="${FILE}" pending><i>fallback</i></pracht-region>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );

    await swapRegions();

    expect(document.querySelector("pracht-region")!.innerHTML).toBe("<i>fallback</i>");
  });

  it("loads the islands bootstrap a region response names", async () => {
    document.body.innerHTML = `<pracht-region region="${FILE}" pending></pracht-region>`;
    mockFetch(() =>
      fragment('<pracht-island island="/src/islands/Counter.tsx"></pracht-island>', {
        "x-pracht-islands": "/assets/islands-client.js",
      }),
    );

    await swapRegions();

    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="/assets/islands-client.js"]',
    );
    expect(script?.type).toBe("module");
    script?.remove();
  });
});

describe("createClientRegion", () => {
  const Region = createClientRegion(FILE);

  it("keeps server-rendered region markup through hydration and re-renders", async () => {
    const calls = mockFetch(() => fragment("<p>refetched</p>"));
    const root = mountRoot(
      `<div><span>0</span><pracht-region region="${FILE}" style="display:contents"><p>Hi, Ada</p></pracht-region></div>`,
    );

    let setCount: (value: number) => void = () => {};
    function Page() {
      const [count, set] = useState(0);
      setCount = set;
      return h("div", null, h("span", null, String(count)), h(Region, { greeting: "Hi" }));
    }

    await act(() => hydrate(h(Page, null), root));
    await flush();
    expect(root.querySelector("pracht-region")!.innerHTML).toBe("<p>Hi, Ada</p>");

    await act(() => setCount(1));
    await flush();
    expect(root.querySelector("span")!.textContent).toBe("1");
    expect(root.querySelector("pracht-region")!.innerHTML).toBe("<p>Hi, Ada</p>");
    // Rendered inline by the server: nothing to fetch.
    expect(calls).toHaveLength(0);
  });

  it("fills a pending server placeholder after hydration", async () => {
    const calls = mockFetch(() => fragment("<p>Hi, Ada</p>"));
    const root = mountRoot(
      `<pracht-region region="${FILE}" props='{"greeting":"Hi"}' style="display:contents" pending><i>…</i></pracht-region>`,
    );

    await act(() => hydrate(h(Region, { greeting: "Hi" }), root));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("props")).toBe('{"greeting":"Hi"}');
    const element = root.querySelector("pracht-region")!;
    expect(element.innerHTML).toBe("<p>Hi, Ada</p>");
    expect(element.hasAttribute("pending")).toBe(false);
  });

  it("shows the fallback, then the region, when mounted by a client navigation", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const root = mountRoot();

    await act(() => render(h(Region, { greeting: "Hi", fallback: h("i", null, "loading") }), root));
    const element = root.querySelector("pracht-region")!;
    expect(element.innerHTML).toBe("<i>loading</i>");

    resolveFetch(fragment("<p>Hi, Ada</p>"));
    await flush();
    expect(element.innerHTML).toBe("<p>Hi, Ada</p>");

    await act(() => render(null, root));
  });

  it("refetches when route data is refreshed in place, and keeps the HTML meanwhile", async () => {
    let answer: () => Promise<Response> = async () => fragment("<p>Cart (1)</p>");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(input);
        return answer();
      }),
    );
    const root = mountRoot(
      `<pracht-region region="${FILE}" style="display:contents"><p>Cart (0)</p></pracht-region>`,
    );

    await act(() => hydrate(h(Region, { fallback: h("i", null, "Cart") }), root));
    await flush();
    const element = root.querySelector("pracht-region")!;
    expect(calls).toHaveLength(0);

    // `useRevalidate()`, a capability call, or a <Form> submission.
    await act(() => {
      window.dispatchEvent(new Event("pracht:regions-refresh"));
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(element.innerHTML).toBe("<p>Cart (1)</p>");

    // A refresh that fails in transit keeps what is on screen.
    answer = () => Promise.reject(new TypeError("offline"));
    await act(() => {
      window.dispatchEvent(new Event("pracht:regions-refresh"));
    });
    await flush();
    expect(element.innerHTML).toBe("<p>Cart (1)</p>");

    // One that no longer yields a region (signed out) shows the fallback
    // rather than the previous visitor's HTML.
    answer = async () => new Response(null, { status: 204 });
    await act(() => {
      window.dispatchEvent(new Event("pracht:regions-refresh"));
    });
    await flush();
    expect(element.innerHTML).toBe("<i>Cart</i>");

    answer = async () => fragment("<p>Cart (2)</p>");
    await act(() => {
      window.dispatchEvent(new Event("pracht:regions-refresh"));
    });
    await flush();
    expect(element.innerHTML).toBe("<p>Cart (2)</p>");

    await act(() => render(null, root));
    await act(() => {
      window.dispatchEvent(new Event("pracht:regions-refresh"));
    });
    await flush();
    expect(calls).toHaveLength(4);
  });
});
