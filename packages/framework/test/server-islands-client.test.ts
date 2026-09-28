// @vitest-environment jsdom
import { h, hydrate, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { swapServerIslands } from "../src/server-islands-client.ts";
import { createClientServerIsland } from "../src/server-islands-component.ts";

const FILE = "/src/server-islands/Visitor.tsx";

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

/** A server island endpoint fragment: status 200 and the endpoint's marker header. */
function fragment(html: string, headers: Record<string, string> = {}) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html", "x-pracht-server-island": "1", ...headers },
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Every Preact root a test mounted: unmounted after it, so no server island keeps
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
  document.documentElement.removeAttribute("data-pracht-server-islands-ready");
  history.replaceState(null, "", "/");
});

describe("swapServerIslands", () => {
  it("fetches each pending server island for the current page and swaps its HTML in", async () => {
    history.replaceState(null, "", "/products/7?ref=home");
    document.body.innerHTML =
      `<pracht-server-island island="${FILE}" props='{"greeting":"Hi"}' pending><i>…</i></pracht-server-island>` +
      `<pracht-server-island island="${FILE}"><b>inline</b></pracht-server-island>`;
    const calls = mockFetch(() => fragment("<p>Hi, Ada</p>"));

    await swapServerIslands();

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/__pracht/server-island");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      island: FILE,
      path: "/products/7?ref=home",
      props: '{"greeting":"Hi"}',
    });
    expect(calls[0].init!.headers).toEqual({ "x-pracht-server-island": "1" });

    const [pending, inline] = document.querySelectorAll("pracht-server-island");
    expect(pending.innerHTML).toBe("<p>Hi, Ada</p>");
    expect(pending.hasAttribute("pending")).toBe(false);
    expect(inline.innerHTML).toBe("<b>inline</b>");
    expect(document.documentElement.getAttribute("data-pracht-server-islands-ready")).toBe("true");
  });

  it("keeps the fallback when the endpoint has no server island for this visitor", async () => {
    document.body.innerHTML = `<pracht-server-island island="${FILE}" pending><i>fallback</i></pracht-server-island>`;
    mockFetch(() => new Response(null, { status: 204 }));

    await swapServerIslands();

    const serverIsland = document.querySelector("pracht-server-island")!;
    expect(serverIsland.innerHTML).toBe("<i>fallback</i>");
    expect(serverIsland.hasAttribute("pending")).toBe(true);
    expect(document.documentElement.getAttribute("data-pracht-server-islands-ready")).toBe("true");
  });

  it("keeps the fallback when a 200 is not the endpoint's fragment", async () => {
    // A static host answering unknown URLs with its SPA fallback document.
    document.body.innerHTML = `<pracht-server-island island="${FILE}" pending><i>fallback</i></pracht-server-island>`;
    mockFetch(
      () =>
        new Response("<!doctype html><html><body>app shell</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    await swapServerIslands();

    const serverIsland = document.querySelector("pracht-server-island")!;
    expect(serverIsland.innerHTML).toBe("<i>fallback</i>");
    expect(serverIsland.hasAttribute("pending")).toBe(true);
  });

  it("keeps the fallback when the request fails", async () => {
    document.body.innerHTML = `<pracht-server-island island="${FILE}" pending><i>fallback</i></pracht-server-island>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );

    await swapServerIslands();

    expect(document.querySelector("pracht-server-island")!.innerHTML).toBe("<i>fallback</i>");
  });

  it("loads the islands bootstrap a server island response names", async () => {
    document.body.innerHTML = `<pracht-server-island island="${FILE}" pending></pracht-server-island>`;
    mockFetch(() =>
      fragment('<pracht-island island="/src/islands/Counter.tsx"></pracht-island>', {
        "x-pracht-islands": "/assets/islands-client.js",
      }),
    );

    await swapServerIslands();

    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="/assets/islands-client.js"]',
    );
    expect(script?.type).toBe("module");
    script?.remove();
  });
});

describe("createClientServerIsland", () => {
  const ServerIsland = createClientServerIsland(FILE);

  it("keeps server-rendered server island markup through hydration and re-renders", async () => {
    const calls = mockFetch(() => fragment("<p>refetched</p>"));
    const root = mountRoot(
      `<div><span>0</span><pracht-server-island island="${FILE}" style="display:contents"><p>Hi, Ada</p></pracht-server-island></div>`,
    );

    let setCount: (value: number) => void = () => {};
    function Page() {
      const [count, set] = useState(0);
      setCount = set;
      return h("div", null, h("span", null, String(count)), h(ServerIsland, { greeting: "Hi" }));
    }

    await act(() => hydrate(h(Page, null), root));
    await flush();
    expect(root.querySelector("pracht-server-island")!.innerHTML).toBe("<p>Hi, Ada</p>");

    await act(() => setCount(1));
    await flush();
    expect(root.querySelector("span")!.textContent).toBe("1");
    expect(root.querySelector("pracht-server-island")!.innerHTML).toBe("<p>Hi, Ada</p>");
    // Rendered inline by the server: nothing to fetch.
    expect(calls).toHaveLength(0);
  });

  it("fills a pending server placeholder after hydration", async () => {
    const calls = mockFetch(() => fragment("<p>Hi, Ada</p>"));
    const root = mountRoot(
      `<pracht-server-island island="${FILE}" props='{"greeting":"Hi"}' style="display:contents" pending><i>…</i></pracht-server-island>`,
    );

    await act(() => hydrate(h(ServerIsland, { greeting: "Hi" }), root));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("props")).toBe('{"greeting":"Hi"}');
    const element = root.querySelector("pracht-server-island")!;
    expect(element.innerHTML).toBe("<p>Hi, Ada</p>");
    expect(element.hasAttribute("pending")).toBe(false);
  });

  it("shows the fallback, then the server island, when mounted by a client navigation", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const root = mountRoot();

    await act(() =>
      render(h(ServerIsland, { greeting: "Hi", fallback: h("i", null, "loading") }), root),
    );
    const element = root.querySelector("pracht-server-island")!;
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
      `<pracht-server-island island="${FILE}" style="display:contents"><p>Cart (0)</p></pracht-server-island>`,
    );

    await act(() => hydrate(h(ServerIsland, { fallback: h("i", null, "Cart") }), root));
    await flush();
    const element = root.querySelector("pracht-server-island")!;
    expect(calls).toHaveLength(0);

    // `useRevalidate()`, a capability call, or a <Form> submission.
    await act(() => {
      window.dispatchEvent(new Event("pracht:server-islands-refresh"));
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(element.innerHTML).toBe("<p>Cart (1)</p>");

    // A refresh that fails in transit keeps what is on screen.
    answer = () => Promise.reject(new TypeError("offline"));
    await act(() => {
      window.dispatchEvent(new Event("pracht:server-islands-refresh"));
    });
    await flush();
    expect(element.innerHTML).toBe("<p>Cart (1)</p>");

    // One that no longer yields a server island (signed out) shows the fallback
    // rather than the previous visitor's HTML.
    answer = async () => new Response(null, { status: 204 });
    await act(() => {
      window.dispatchEvent(new Event("pracht:server-islands-refresh"));
    });
    await flush();
    expect(element.innerHTML).toBe("<i>Cart</i>");

    answer = async () => fragment("<p>Cart (2)</p>");
    await act(() => {
      window.dispatchEvent(new Event("pracht:server-islands-refresh"));
    });
    await flush();
    expect(element.innerHTML).toBe("<p>Cart (2)</p>");

    await act(() => render(null, root));
    await act(() => {
      window.dispatchEvent(new Event("pracht:server-islands-refresh"));
    });
    await flush();
    expect(calls).toHaveLength(4);
  });
});
