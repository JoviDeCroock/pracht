// @vitest-environment jsdom
import { h, hydrate } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { beforeEach, describe, expect, it } from "vitest";

import { canSwapDocument, markServerNodes, prepareSwap } from "../src/islands-navigation.ts";

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
  markServerNodes(document);
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

  it("accepts a hydration: none page", () => {
    expect(canSwapDocument(parse('<div id="pracht-root"></div>'), known)).toBe(true);
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

describe("prepareSwap", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    document.title = "";
  });

  it("keeps equal head nodes, adds new ones, and removes the old page's", () => {
    load(`<html><head>
      <title>Old</title>
      <link rel="stylesheet" href="/shared.css">
      <link rel="stylesheet" href="/old.css">
      <meta name="description" content="old">
    </head><body><div id="pracht-root"></div></body></html>`);
    const shared = document.head.querySelector('link[href="/shared.css"]');
    // Injected after load (dev CSS, an island's own style tag): not the swap's.
    const injected = document.createElement("style");
    document.head.append(injected);

    const swap = prepareSwap(
      parse(`<html lang="nl"><head>
        <title>New</title>
        <link rel="stylesheet" href="/shared.css">
        <link rel="stylesheet" href="/new.css">
        <meta name="description" content="new">
      </head><body><div id="pracht-root"><h1>New</h1></div></body></html>`),
    );
    // The new stylesheet is in before the swap so it can load first.
    expect(document.head.querySelector('link[href="/new.css"]')).not.toBeNull();
    expect(document.querySelector("h1")).toBeNull();

    swap.apply();

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

  it("takes back the stylesheets of a swap that is cancelled", () => {
    load(`<html><head></head><body><div id="pracht-root"><h1>Old</h1></div></body></html>`);
    const swap = prepareSwap(
      parse(`<html><head><link rel="stylesheet" href="/new.css"></head>
        <body><div id="pracht-root"><h1>New</h1></div></body></html>`),
    );
    swap.cancel();

    expect(document.head.querySelector('link[href="/new.css"]')).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Old");
  });

  it("brings the new page's scripts, keeps the bootstrap, and leaves non-server nodes alone", () => {
    load(`<html><head></head><body><div id="pracht-root"></div>
      <script type="module" src="/assets/islands-client.js"></script></body></html>`);
    const bootstrap = document.body.querySelector("script");
    const portal = document.createElement("div");
    document.body.append(portal);

    prepareSwap(
      parse(`<html><head><script>window.inlineRan = true</script></head><body>
        <div id="pracht-root"><p>body<script>window.bodyRan = true</script></p></div>
        <script type="module" src="/assets/islands-client.js"></script></body></html>`),
    ).apply();

    expect(document.body.querySelector('script[src="/assets/islands-client.js"]')).toBe(bootstrap);
    expect(document.body.contains(portal)).toBe(true);
    expect(document.head.querySelector("script")?.textContent).toBe("window.inlineRan = true");
    expect(document.querySelector("#pracht-root script")?.textContent).toBe(
      "window.bodyRan = true",
    );
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
    ).apply();

    const [nextShell, nextCounter] = document.querySelectorAll("pracht-island");
    expect(nextShell).toBe(shellIsland);
    expect(nextShell.textContent).toBe("live");
    // Different props: a different island, rendered fresh from the server.
    expect(nextCounter).not.toBe(counterIsland);
    expect(nextCounter.hasAttribute("data-hydrated")).toBe(false);
    expect(cleanedUp).toBe(true);
  });
});
