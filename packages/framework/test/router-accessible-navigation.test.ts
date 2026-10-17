// @vitest-environment jsdom
import { h, render } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";
import { _resetNavigationForTesting } from "../src/navigation-state.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";

async function flush(ms = 0): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}

const app = resolveApp(
  defineApp({
    routes: [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
      route("/about", "./routes/about.tsx", { id: "about", render: "ssr" }),
      route("/form", "./routes/form.tsx", { id: "form", render: "ssr" }),
      route("/grabs", "./routes/grabs.tsx", { id: "grabs", render: "ssr" }),
      route("/titled", "./routes/titled.tsx", { id: "titled", render: "ssr" }),
    ],
  }),
);

function Home() {
  return h("main", null, h("h1", null, "Home"), h("input", { id: "search" }));
}

function Grabs() {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return h("main", null, h("h1", null, "Grabs"), h("button", { id: "grab", ref }, "mine"));
}

function Titled() {
  useEffect(() => {
    document.title = "Titled page";
  }, []);
  return h("main", null, h("h1", null, "Heading"));
}

const routeModules = {
  "./routes/home.tsx": async () => ({ default: Home }),
  "./routes/about.tsx": async () => ({
    default: () => h("main", null, h("h1", null, "About us")),
  }),
  "./routes/form.tsx": async () => ({
    default: () =>
      h("main", null, h("h1", null, "Form"), h("input", { id: "auto", autofocus: true })),
  }),
  "./routes/grabs.tsx": async () => ({ default: Grabs }),
  "./routes/titled.tsx": async () => ({ default: Titled }),
};

describe("client router: focus and announcement after navigation", () => {
  let root: HTMLDivElement;
  let link: HTMLAnchorElement;
  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

  beforeEach(async () => {
    document.body.innerHTML = "";
    document.title = "Start";
    link = document.createElement("a");
    link.href = "/about";
    link.textContent = "persistent nav link";
    document.body.appendChild(link);
    root = document.createElement("div");
    root.innerHTML = '<main><h1>Home</h1><input id="search"></main>';
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"data":null}', { headers: { "content-type": "application/json" } }),
      ),
    );
    sessionStorage.clear();
    clearPrefetchCache();
    _resetNavigationForTesting();

    const targets: EventTarget[] = [window, document];
    const originals = targets.map((target) => target.addEventListener.bind(target));
    targets.forEach((target, i) => {
      target.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject) => {
        listeners.push([target, type, handler]);
        originals[i](type, handler);
      }) as typeof target.addEventListener;
    });
    try {
      await initClientRouter({
        app,
        routeModules,
        shellModules: {},
        initialState: { data: null, routeId: "home", url: "/" },
        root,
        findModuleKey: (_modules, file) => file,
      });
    } finally {
      targets.forEach((target, i) => {
        target.addEventListener = originals[i] as typeof target.addEventListener;
      });
    }
  });

  afterEach(() => {
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    listeners.length = 0;
    render(null, root);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    _resetNavigationForTesting();
  });

  const announcement = () => document.querySelector("[data-pracht-announcer]")?.textContent;

  it("starts focus over at the top of the new page and announces its heading", async () => {
    link.focus();
    link.click();
    await vi.waitFor(() => expect(root.textContent).toBe("About us"));
    await flush();

    expect(window.location.pathname).toBe("/about");
    expect(document.activeElement).toBe(document.body);
    expect(document.body.hasAttribute("tabindex")).toBe(false);
    const region = document.querySelector("[data-pracht-announcer]");
    expect(region?.getAttribute("aria-live")).toBe("assertive");
    await vi.waitFor(() => expect(announcement()).toBe("About us"));
  });

  it("focuses the new page's autofocus element", async () => {
    await window.__PRACHT_NAVIGATE__!("/form");
    await flush();
    expect(document.activeElement?.id).toBe("auto");
  });

  it("leaves focus the page moved itself", async () => {
    link.focus();
    await window.__PRACHT_NAVIGATE__!("/grabs");
    await flush();
    expect(document.activeElement?.id).toBe("grab");
  });

  it("announces a title the page sets", async () => {
    await window.__PRACHT_NAVIGATE__!("/titled");
    await flush(60);
    await vi.waitFor(() => expect(announcement()).toBe("Titled page"));
  });

  it("neither moves focus nor announces when only the query changes", async () => {
    const input = root.querySelector<HTMLInputElement>("#search")!;
    input.focus();
    await window.__PRACHT_NAVIGATE__!("/?q=pr", { replace: true });
    await flush(60);
    expect(document.activeElement).toBe(input);
    expect(announcement() ?? "").toBe("");
  });
});
