// @vitest-environment jsdom
import { h, hydrate } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { beforeEach, describe, expect, it } from "vitest";

import {
  canSwapDocument,
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
