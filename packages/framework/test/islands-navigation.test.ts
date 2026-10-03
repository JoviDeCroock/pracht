// @vitest-environment jsdom
import { h, hydrate } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { beforeEach, describe, expect, it } from "vitest";

import { canSwapDocument, isSwappableRoute, prepareSwap } from "../src/islands-navigation.ts";
import { policyFingerprint } from "../src/islands-shared.ts";
import { islandsNavigationRoutes } from "../src/islands-server.ts";
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

describe("isSwappableRoute", () => {
  const at = (path: string) => `http://localhost:3000${path}`;

  it("matches the server's way: first match wins, API routes first", () => {
    const table = ["-/api/*", "+/", "+/blog/:slug", "-/blog/:slug/edit", "+/docs/*"];
    expect(isSwappableRoute(table, at("/"))).toBe(true);
    expect(isSwappableRoute(table, at("/blog/hello"))).toBe(true);
    expect(isSwappableRoute(table, at("/blog/hello/"))).toBe(true);
    expect(isSwappableRoute(table, at("/blog/hello/edit"))).toBe(false);
    expect(isSwappableRoute(table, at("/blog"))).toBe(false);
    expect(isSwappableRoute(table, at("/docs"))).toBe(true);
    expect(isSwappableRoute(table, at("/docs/a/b"))).toBe(true);
    expect(isSwappableRoute(table, at("/api/docs"))).toBe(false);
    expect(isSwappableRoute(table, at("/unknown"))).toBe(false);
    expect(isSwappableRoute(table, "https://elsewhere.example/blog/hello")).toBe(false);
  });

  it("does not match a segment the server could not decode", () => {
    expect(isSwappableRoute(["+/blog/:slug"], at("/blog/%E0%A4%A"))).toBe(false);
  });

  it("is built from the resolved app, stopping at the last swappable route", () => {
    const app = resolveApp(
      defineApp({
        routes: [
          route("/full", "./full.tsx"),
          route("/guide", "./guide.tsx", { hydration: "islands" }),
          route("/static", "./static.tsx", { hydration: "none", render: "ssg" }),
          route("/dash", "./dash.tsx", { render: "spa" }),
        ],
      }),
    );
    expect(islandsNavigationRoutes(app, [{ path: "/api/hello", file: "x", segments: [] }])).toEqual(
      ["-/api/hello", "-/full", "+/guide", "+/static"],
    );
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
