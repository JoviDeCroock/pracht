// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";
import { fetchPrachtRouteState } from "../src/runtime-client-fetch.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";

/** A response the browser hands back for a 3xx it was told not to follow. */
function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
}

describe("fetchPrachtRouteState() on an opaque redirect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports the redirect without inventing a destination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(opaqueRedirect()));

    const result = await fetchPrachtRouteState("/next");

    // Reporting `/next` here — the URL just requested — is what made the
    // client redirect to itself forever.
    expect(result).toEqual({ type: "redirect" });
  });

  it("still reads the location of a readable 3xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "/in" } })),
    );

    expect(await fetchPrachtRouteState("/next")).toEqual({ type: "redirect", location: "/in" });
  });
});

describe("client redirect handling", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let hrefSpy: ReturnType<typeof vi.fn>;

  async function initRouter(): Promise<void> {
    const app = resolveApp(
      defineApp({
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          route("/a", "./routes/a.tsx", { id: "a", render: "ssr" }),
          route("/b", "./routes/b.tsx", { id: "b", render: "ssr" }),
        ],
      }),
    );
    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: () => null }),
        "./routes/a.tsx": async () => ({ default: () => null }),
        "./routes/b.tsx": async () => ({ default: () => null }),
      },
      shellModules: {},
      initialState: { data: null, routeId: "home", url: "/" },
      root,
      findModuleKey: (_modules, file) => file,
    });
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    clearPrefetchCache();

    hrefSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        get href() {
          return "http://localhost/";
        },
        set href(value: string) {
          hrefSpy(value);
        },
        replace: vi.fn(),
        assign: vi.fn(),
        origin: "http://localhost",
        pathname: "/",
        search: "",
        hash: "",
      },
    });
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  });

  it("stops a loader redirect chain after twenty hops", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // /a bounces to /b, /b bounces back to /a: a chain with no end.
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(
        Response.json(
          { redirect: url.includes("/a") ? "/b" : "/a" },
          {
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await initRouter();
    fetchSpy.mockClear();

    await window.__PRACHT_NAVIGATE__!("/a");

    // Twenty hops followed, the twenty-first refused.
    expect(fetchSpy).toHaveBeenCalledTimes(21);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/too many redirects/));
  });

  it("hands an opaque redirect to the browser instead of re-fetching the same URL", async () => {
    fetchSpy.mockResolvedValue(opaqueRedirect());

    await initRouter();
    fetchSpy.mockClear();

    await window.__PRACHT_NAVIGATE__!("/a");

    // One attempt, then a document navigation so the browser follows the 3xx.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hrefSpy).toHaveBeenCalledWith("/a");
  });
});
