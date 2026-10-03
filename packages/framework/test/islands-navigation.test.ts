// @vitest-environment jsdom
import { h, hydrate } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canSwapDocument,
  installIslandsNavigation,
  matchRoute,
  prepareSwap,
  settleFocus,
} from "../src/islands-navigation.ts";
import { policyFingerprint } from "../src/islands-shared.ts";
import { islandsNavigationRoutes, patternsOverlap } from "../src/islands-server.ts";
import { resolveApp, route, defineApp } from "../src/index.ts";

const OWN = "data-pracht-owned";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function load(html: string): void {
  const doc = parse(html);
  document.head.replaceChildren(
    ...[...doc.head.childNodes].map((n) => document.importNode(n, true)),
  );
  document.body.replaceChildren(
    ...[...doc.body.childNodes].map((n) => document.importNode(n, true)),
  );
}

const island = (file: string, props?: string, inner = "<button>live</button>") =>
  `<pracht-island island="${file}" export="default"${props ? ` props='${props}'` : ""}>${inner}</pracht-island>`;

describe("canSwapDocument", () => {
  const known = new Set(["http://localhost:3000/assets/islands-client.js"]);

  it("accepts an islands page whose bootstrap this document already ran", () => {
    const doc = parse(
      '<div id="pracht-root"></div><script type="module" src="/assets/islands-client.js"></script>',
    );
    expect(canSwapDocument(doc, known)).toBe(true);
  });

  it("rejects a full-hydration page", () => {
    const doc = parse(
      '<div id="pracht-root"></div><script id="pracht-state" type="application/json">{}</script>',
    );
    expect(canSwapDocument(doc, known)).toBe(false);
  });

  it("rejects a page that needs a module script this document never loaded", () => {
    const doc = parse(
      '<div id="pracht-root"></div><script type="module" src="/assets/islands-client-NEW.js"></script>',
    );
    expect(canSwapDocument(doc, known)).toBe(false);
  });

  it("rejects a document that is not a pracht page", () => {
    expect(canSwapDocument(parse("<p>maintenance</p>"), known)).toBe(false);
  });
});

describe("matchRoute", () => {
  const at = (path: string) => `http://localhost:3000${path}`;
  const swappable = (table: string[], href: string) => matchRoute(table, href)?.[0] === "+";

  it("matches the server's way: first match wins, API routes first", () => {
    const table = ["-/api/*", "+/", "+/blog/:slug", "-/blog/:slug/edit", "+/docs/*"];
    expect(swappable(table, at("/"))).toBe(true);
    expect(matchRoute(table, at("/blog/hello"))).toBe("+/blog/:slug");
    expect(swappable(table, at("/blog/hello/"))).toBe(true);
    expect(matchRoute(table, at("/blog/hello/edit"))).toBe("-/blog/:slug/edit");
    expect(matchRoute(table, at("/blog"))).toBeUndefined();
    expect(swappable(table, at("/docs"))).toBe(true);
    expect(swappable(table, at("/docs/a/b"))).toBe(true);
    expect(swappable(table, at("/api/docs"))).toBe(false);
    expect(matchRoute(table, at("/unknown"))).toBeUndefined();
    expect(matchRoute(table, "https://elsewhere.example/blog/hello")).toBeUndefined();
  });

  it("does not match a segment the server could not decode", () => {
    expect(matchRoute(["+/blog/:slug"], at("/blog/%E0%A4%A"))).toBeUndefined();
    expect(matchRoute(["+/docs/*"], at("/docs/a/%E0%A4%A"))).toBeUndefined();
  });
});

describe("islandsNavigationRoutes", () => {
  it("lists swappable routes and only the routes that could shadow one", () => {
    const app = resolveApp(
      defineApp({
        routes: [
          route("/full", "./full.tsx"),
          route("/blog/drafts", "./drafts.tsx"),
          route("/blog/:slug", "./post.tsx", { hydration: "islands" }),
          route("/static", "./static.tsx", { hydration: "none", render: "ssg" }),
          route("/dash", "./dash.tsx", { render: "spa" }),
        ],
      }),
    );
    expect(
      islandsNavigationRoutes(app, [
        { path: "/api/hello", file: "x", segments: [] },
        { path: "/api/*", file: "y", segments: [] },
      ]),
    ).toEqual(["-/blog/drafts", "+/blog/:slug", "+/static"]);
  });

  it("decides overlap segment by segment", () => {
    expect(patternsOverlap("-/a/:id", "+/a/b")).toBe(true);
    expect(patternsOverlap("-/a/b", "+/a/c")).toBe(false);
    expect(patternsOverlap("-/a", "+/a/b")).toBe(false);
    expect(patternsOverlap("-/*", "+/a/b")).toBe(true);
    expect(patternsOverlap("-/a/b/c", "+/a/:rest*")).toBe(true);
    expect(patternsOverlap("-/", "+/")).toBe(true);
  });
});

describe("policyFingerprint", () => {
  it("changes with any document-policy header and ignores the rest", () => {
    const base = new Headers({ "referrer-policy": "no-referrer", "cache-control": "no-store" });
    const same = new Headers({ "referrer-policy": "no-referrer", etag: "x" });
    const framed = new Headers({ "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
    expect(policyFingerprint(base)).toBe(policyFingerprint(same));
    expect(policyFingerprint(base)).not.toBe(policyFingerprint(framed));
  });
});

describe("prepareSwap", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    document.title = "";
  });

  it("keeps equal owned head nodes, adds new ones, and removes the old page's", () => {
    load(`<html><head>
      <title ${OWN}>Old</title>
      <link ${OWN} rel="stylesheet" href="/shared.css">
      <link ${OWN} rel="stylesheet" href="/old.css">
      <meta ${OWN} name="description" content="old">
    </head><body><div id="pracht-root"></div></body></html>`);
    const shared = document.head.querySelector('link[href="/shared.css"]');
    // Added by a script, not by the server: not the swap's to remove.
    const injected = document.createElement("style");
    document.head.append(injected);

    const swap = prepareSwap(
      parse(`<html lang="nl"><head>
        <title ${OWN}>New</title>
        <link ${OWN} rel="stylesheet" href="/shared.css">
        <link ${OWN} rel="stylesheet" href="/new.css">
        <meta ${OWN} name="description" content="new">
      </head><body><div id="pracht-root"><h1>New</h1></div></body></html>`),
    )!;
    // The new stylesheet is in before the swap so it can load first, but
    // disabled so it cannot restyle the page that is still showing.
    const incomingSheet = document.head.querySelector<HTMLLinkElement>('link[href="/new.css"]');
    expect(incomingSheet?.media).toBe("not all");
    expect(document.querySelector("h1")).toBeNull();

    swap.apply();

    expect(incomingSheet?.hasAttribute("media")).toBe(false);
    expect(document.head.querySelector('link[href="/shared.css"]')).toBe(shared);
    expect(document.head.querySelector('link[href="/old.css"]')).toBeNull();
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      "new",
    );
    expect(document.head.contains(injected)).toBe(true);
    expect(document.title).toBe("New");
    expect(document.documentElement.lang).toBe("nl");
    expect(document.querySelector("h1")?.textContent).toBe("New");
    const hrefs = [...document.head.querySelectorAll("link")].map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/shared.css", "/new.css"]);
  });

  it("refuses a page whose shared stylesheets are in another order", () => {
    load(`<html><head>
      <link ${OWN} rel="stylesheet" href="/one.css">
      <link ${OWN} rel="stylesheet" href="/two.css">
    </head><body><div id="pracht-root"></div></body></html>`);
    expect(
      prepareSwap(
        parse(`<html><head>
          <link ${OWN} rel="stylesheet" href="/two.css">
          <link ${OWN} rel="stylesheet" href="/one.css">
        </head><body><div id="pracht-root"></div></body></html>`),
      ),
    ).toBeNull();
  });

  it("takes back the stylesheets of a swap that is cancelled", () => {
    load(`<html><head></head><body><div id="pracht-root"><h1>Old</h1></div></body></html>`);
    const swap = prepareSwap(
      parse(`<html><head><link ${OWN} rel="stylesheet" href="/new.css"></head>
        <body><div id="pracht-root"><h1>New</h1></div></body></html>`),
    )!;
    swap.cancel();

    expect(document.head.querySelector('link[href="/new.css"]')).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Old");
  });

  it("carries an island both pages share across, and unmounts the one that leaves", () => {
    load(`<html><head></head><body><div id="pracht-root">
      <header>${island("/src/islands/Shell.tsx")}</header>
      <main>${island("/src/islands/Counter.tsx", '{"start":1}')}</main>
    </div></body></html>`);
    const [shellIsland, counterIsland] = document.querySelectorAll("pracht-island");
    let cleanedUp = false;
    function Counter() {
      useLayoutEffect(() => () => void (cleanedUp = true), []);
      return h("button", null, "live");
    }
    hydrate(h(Counter, null), counterIsland);
    counterIsland.setAttribute("data-hydrated", "true");
    shellIsland.setAttribute("data-hydrated", "true");

    prepareSwap(
      parse(`<html><head></head><body><div id="pracht-root">
        <header>${island("/src/islands/Shell.tsx", undefined, "<button>server</button>")}</header>
        <main>${island("/src/islands/Counter.tsx", '{"start":2}', "<button>server</button>")}</main>
      </div></body></html>`),
    )!.apply();

    const [nextShell, nextCounter] = document.querySelectorAll("pracht-island");
    expect(nextShell).toBe(shellIsland);
    expect(nextShell.textContent).toBe("live");
    expect(nextShell.parentElement?.tagName).toBe("HEADER");
    // Different props: a different island, rendered fresh from the server.
    expect(nextCounter).not.toBe(counterIsland);
    expect(nextCounter.hasAttribute("data-hydrated")).toBe(false);
    expect(cleanedUp).toBe(true);
  });

  it("leaves an island nested in a carried island where it is", () => {
    const inner = (text: string) => island("/src/islands/Inner.tsx", undefined, `<b>${text}</b>`);
    load(`<html><head></head><body><div id="pracht-root">
      <main>${island("/src/islands/Outer.tsx", undefined, `<div>${inner("live")}</div>`)}</main>
    </div></body></html>`);
    const [outer, nested] = document.querySelectorAll("pracht-island");
    let unmounted = false;
    function Inner() {
      useLayoutEffect(() => () => void (unmounted = true), []);
      return h("b", null, "live");
    }
    hydrate(h(Inner, null), nested);
    nested.setAttribute("data-hydrated", "true");

    prepareSwap(
      parse(`<html><head></head><body><div id="pracht-root">
        <main>${island("/src/islands/Outer.tsx", undefined, `<div>${inner("server")}</div>`)}</main>
      </div></body></html>`),
    )!.apply();

    expect(document.querySelector("pracht-island")).toBe(outer);
    expect(nested.isConnected).toBe(true);
    expect(outer.contains(nested)).toBe(true);
    expect(nested.textContent).toBe("live");
    expect(unmounted).toBe(false);
  });

  const slot = (inner: string) =>
    `<pracht-slot style="display:contents">${inner}<!--/pracht-slot--></pracht-slot>`;

  it("renders an island fresh when its page passes it other children", () => {
    load(`<html><head></head><body><div id="pracht-root">
      <main>${island("/src/islands/Disclosure.tsx", undefined, `<div>${slot("<p>one</p>")}</div>`)}</main>
    </div></body></html>`);
    const live = document.querySelector("pracht-island")!;
    live.setAttribute("data-hydrated", "true");

    prepareSwap(
      parse(`<html><head></head><body><div id="pracht-root">
        <main>${island("/src/islands/Disclosure.tsx", undefined, `<div>${slot("<p>two</p>")}</div>`)}</main>
      </div></body></html>`),
    )!.apply();

    const next = document.querySelector("pracht-island")!;
    expect(next).not.toBe(live);
    expect(next.querySelector("p")?.textContent).toBe("two");
    expect(next.hasAttribute("data-hydrated")).toBe(false);
  });

  it("keeps an island whose children did not change, with the islands among them", () => {
    const inner = (text: string) => island("/src/islands/Inner.tsx", undefined, `<b>${text}</b>`);
    const page = (heading: string) => `<html><head></head><body><div id="pracht-root">
      <h1>${heading}</h1>
      <main>${island("/src/islands/Disclosure.tsx", undefined, `<div>${slot(`<p>same</p>${inner("server")}`)}</div>`)}</main>
    </div></body></html>`;
    load(page("One"));
    // Remembered before hydration, as the bootstrap does.
    (globalThis as { navigation?: unknown }).navigation = { addEventListener() {} };
    const data = document.createElement("script");
    data.type = "application/json";
    data.id = "pracht-nav";
    data.textContent = '{"p":"x","r":["+/a"]}';
    document.head.append(data);
    installIslandsNavigation({ hydrate: async () => {} });
    delete (globalThis as { navigation?: unknown }).navigation;

    const [outer, nested] = document.querySelectorAll("pracht-island");
    let unmounted = false;
    function Inner() {
      useLayoutEffect(() => () => void (unmounted = true), []);
      return h("b", null, "live");
    }
    hydrate(h(Inner, null), nested);
    nested.setAttribute("data-hydrated", "true");
    outer.setAttribute("data-hydrated", "true");

    prepareSwap(parse(page("Two")))!.apply();

    expect(document.querySelector("h1")?.textContent).toBe("Two");
    expect(document.querySelector("pracht-island")).toBe(outer);
    expect(document.querySelectorAll("pracht-island")).toHaveLength(2);
    expect(nested.isConnected).toBe(true);
    expect(outer.contains(nested)).toBe(true);
    expect(nested.textContent).toBe("live");
    expect(unmounted).toBe(false);
  });
});

describe("settleFocus", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    document.body.removeAttribute("tabindex");
  });

  const swapTo = (html: string) =>
    prepareSwap(
      parse(`<html><head></head><body><div id="pracht-root">${html}</div></body></html>`),
    )!;

  it("keeps focus in an island the swap carried over", () => {
    load(`<html><head></head><body><div id="pracht-root">
      ${island("/src/islands/Search.tsx", undefined, '<input id="q">')}<a id="old" href="/b">b</a>
    </div></body></html>`);
    const input = document.querySelector<HTMLInputElement>("#q")!;
    input.focus();
    const swap = swapTo(island("/src/islands/Search.tsx", undefined, "<input>") + "<h1>B</h1>");
    const focused = document.activeElement;
    swap.apply();
    settleFocus(focused);
    expect(document.activeElement).toBe(input);
  });

  it("starts focus over at the top of the new page when the focused element left", () => {
    load(
      `<html><head></head><body><div id="pracht-root"><a id="old" href="/b">b</a></div></body></html>`,
    );
    document.querySelector<HTMLAnchorElement>("#old")!.focus();
    const swap = swapTo("<h1>B</h1>");
    const focused = document.activeElement;
    swap.apply();
    settleFocus(focused);
    expect(document.activeElement).toBe(document.body);
    expect(document.body.hasAttribute("tabindex")).toBe(false);
  });

  it("moves focus to the new page's autofocus element", () => {
    load(
      `<html><head></head><body><div id="pracht-root"><a id="old" href="/b">b</a></div></body></html>`,
    );
    document.querySelector<HTMLAnchorElement>("#old")!.focus();
    const swap = swapTo('<input id="name" autofocus>');
    const focused = document.activeElement;
    swap.apply();
    settleFocus(focused);
    expect(document.activeElement?.id).toBe("name");
  });

  it("takes focus off an element outside the page content", () => {
    load(`<html><head></head><body><div id="pracht-root"><h1>A</h1></div></body></html>`);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const swap = swapTo("<h1>B</h1>");
    swap.apply();
    settleFocus(outside);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("installIslandsNavigation", () => {
  const origin = location.origin;
  type Listener = (event: Record<string, unknown>) => void;

  function fakeNavigation() {
    const listeners: Record<string, Listener[]> = {};
    const fake = {
      currentEntry: { id: "current", url: `${origin}/a` },
      navigate: vi.fn(),
      addEventListener(type: string, listener: Listener) {
        (listeners[type] ??= []).push(listener);
      },
      dispatch(type: string, event: Record<string, unknown>) {
        for (const listener of listeners[type] ?? []) listener(event);
      },
    };
    (globalThis as { navigation?: unknown }).navigation = fake;
    return fake;
  }

  function traverseTo(id: string, path: string) {
    return {
      navigationType: "traverse",
      canIntercept: true,
      hashChange: false,
      downloadRequest: null,
      formData: null,
      info: undefined,
      signal: new AbortController().signal,
      destination: { id, url: `${origin}${path}`, sameDocument: true, getState: () => "kept" },
      intercept: vi.fn(),
      scroll: vi.fn(),
    };
  }

  beforeEach(() => {
    load(`<html><head><script type="application/json" id="pracht-nav">{"p":"x","r":["+/a","+/b","-/full"]}</script></head>
      <body><div id="pracht-root"><h1>A</h1></div></body></html>`);
  });

  afterEach(() => {
    delete (globalThis as { navigation?: unknown }).navigation;
  });

  it("swaps in the page of an entry an earlier document made", () => {
    const navigation = fakeNavigation();
    installIslandsNavigation({ hydrate: async () => {} });
    const event = traverseTo("from-before-a-reload", "/b");
    navigation.dispatch("navigate", event);
    expect(event.intercept).toHaveBeenCalledOnce();
  });

  it("loads such an entry when its page cannot be swapped", () => {
    const navigation = fakeNavigation();
    installIslandsNavigation({ hydrate: async () => {} });
    const event = traverseTo("from-before-a-reload", "/full");
    navigation.dispatch("navigate", event);
    expect(event.intercept).toHaveBeenCalledOnce();
    const [{ handler }] = event.intercept.mock.calls[0] as [{ handler: () => void }];
    handler();
    expect(navigation.navigate).toHaveBeenCalledWith(`${origin}/full`, {
      history: "replace",
      info: "pracht:full-load",
      state: "kept",
    });
  });

  it("loads a redirect's target without fetching it or the original again", async () => {
    const navigation = fakeNavigation();
    installIslandsNavigation({ hydrate: async () => {} });
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "x-pracht-capability-redirect": "https://sso.example/login" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const event = {
        ...traverseTo("new", "/b"),
        navigationType: "push",
        destination: { id: "new", url: `${origin}/b`, sameDocument: false, getState: () => 1 },
      };
      navigation.dispatch("navigate", event);
      const [{ handler }] = event.intercept.mock.calls[0] as [{ handler: () => Promise<void> }];
      await handler();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]).toMatchObject([
        `${origin}/b`,
        { headers: { "x-pracht-capability-form": "1" } },
      ]);
      expect(navigation.navigate).toHaveBeenCalledOnce();
      expect(navigation.navigate).toHaveBeenCalledWith("https://sso.example/login", {
        history: "replace",
        info: "pracht:full-load",
        state: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores a swapped-out page's scroll position on back", async () => {
    const policy = policyFingerprint(new Headers());
    const page = (title: string) =>
      `<html><head><script ${OWN} type="application/json" id="pracht-nav">{"p":"${policy}","r":["+/a","+/b"]}</script></head><body><div id="pracht-root"><h1>${title}</h1></div></body></html>`;
    load(page("A"));
    const navigation = fakeNavigation();
    Object.assign(navigation.currentEntry, { key: "key-a" });
    installIslandsNavigation({ hydrate: async () => {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(page(url.endsWith("/a") ? "A" : "B"), {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const position = { x: 0, y: 0 };
    vi.spyOn(window, "scrollX", "get").mockImplementation(() => position.x);
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => position.y);
    vi.stubGlobal("scrollTo", (x: number, y: number) => Object.assign(position, { x, y }));
    try {
      const run = async (event: ReturnType<typeof traverseTo>) => {
        navigation.dispatch("navigate", event);
        const [{ handler }] = event.intercept.mock.calls[0] as [{ handler: () => Promise<void> }];
        await handler();
      };
      position.y = 500;
      const push = {
        ...traverseTo("entry-b", "/b"),
        navigationType: "push",
        destination: { id: "entry-b", url: `${origin}/b`, sameDocument: false, getState: () => 0 },
      };
      navigation.dispatch("navigate", push);
      navigation.currentEntry = { id: "entry-b", key: "key-b", url: `${origin}/b` } as never;
      navigation.dispatch("currententrychange", {});
      const [{ handler }] = push.intercept.mock.calls[0] as [{ handler: () => Promise<void> }];
      await handler();
      expect(document.querySelector("h1")?.textContent).toBe("B");
      expect(position.y).toBe(0);

      // The browser's own restore (`event.scroll()`) does nothing here.
      const back = traverseTo("current", "/a");
      Object.assign(back.destination, { key: "key-a" });
      await run(back);
      expect(document.querySelector("h1")?.textContent).toBe("A");
      expect(back.scroll).toHaveBeenCalled();
      expect(position.y).toBe(500);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("leaves traversals within the page that is showing to the app", () => {
    const navigation = fakeNavigation();
    installIslandsNavigation({ hydrate: async () => {} });
    // An app `pushState()` while this page shows.
    navigation.currentEntry = { id: "pushed", url: `${origin}/a?tab=2` };
    navigation.dispatch("currententrychange", {});
    const event = traverseTo("current", "/a");
    navigation.dispatch("navigate", event);
    expect(event.intercept).not.toHaveBeenCalled();
  });
});
