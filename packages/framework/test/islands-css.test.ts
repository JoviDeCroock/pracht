import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
} from "../src/islands-server.ts";
import { withIslandCssAssets } from "../src/runtime-manifest.ts";

afterEach(() => {
  _resetIslandsForTesting();
});

const COUNTER_FILE = "/src/islands/Counter.tsx";
const PANEL_FILE = "/src/islands/Panel.tsx";
const ROUTE_FILE = "./routes/page.tsx";

function Counter() {
  return h("button", { onClick: () => {} }, "Count");
}

function Panel() {
  return h("aside", null, "Panel");
}

interface RenderOptions {
  Component: (props: any) => any;
  cssContentManifest?: Record<string, string>;
  cssManifest?: Record<string, string[]>;
}

async function render(options: RenderOptions): Promise<string> {
  registerServerIslands({
    [COUNTER_FILE]: { default: Counter },
    [PANEL_FILE]: { default: Panel },
  });
  setIslandsClientEntryUrl("/assets/islands-client.js");

  const response = await handlePrachtRequest({
    app: defineApp({
      routes: [route("/", ROUTE_FILE, { render: "ssr", hydration: "islands" })],
    }),
    registry: {
      routeModules: { [ROUTE_FILE]: async () => ({ Component: options.Component }) },
    },
    request: new Request("http://localhost/"),
    debugErrors: true,
    cssManifest: options.cssManifest,
    cssContentManifest: options.cssContentManifest,
  });

  return response.text();
}

describe("island stylesheets", () => {
  it("links the CSS of every island the page rendered", async () => {
    const html = await render({
      Component: () => h("main", null, h(Counter, null)),
      cssManifest: {
        [ROUTE_FILE]: ["/assets/page.css"],
        [COUNTER_FILE]: ["/assets/counter.css"],
        [PANEL_FILE]: ["/assets/panel.css"],
      },
    });

    expect(html).toContain('<link rel="stylesheet" href="/assets/page.css">');
    expect(html).toContain('<link rel="stylesheet" href="/assets/counter.css">');
    // An island the page did not render contributes nothing.
    expect(html).not.toContain("/assets/panel.css");
  });

  it("inlines island CSS when the content manifest carries it", async () => {
    const html = await render({
      Component: () => h("main", null, h(Counter, null)),
      cssManifest: {
        [ROUTE_FILE]: ["/assets/page.css"],
        [COUNTER_FILE]: ["/assets/counter.css"],
      },
      cssContentManifest: {
        "/assets/page.css": ".page{color:red}",
        "/assets/counter.css": ".counter{color:blue}",
      },
    });

    // Adjacent inline stylesheets are emitted as a single <style> block.
    expect(html).toContain(
      "<style data-pracht-inline-css>.page{color:red}\n.counter{color:blue}</style>",
    );
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("orders island CSS after the route's, so island rules win on equal specificity", async () => {
    const html = await render({
      Component: () => h("main", null, h(Counter, null)),
      cssManifest: {
        [ROUTE_FILE]: ["/assets/page.css"],
        [COUNTER_FILE]: ["/assets/counter.css"],
      },
    });

    expect(html.indexOf("/assets/page.css")).toBeLessThan(html.indexOf("/assets/counter.css"));
  });

  it("ships CSS for deferred islands, whose markup paints before their JavaScript", async () => {
    const html = await render({
      // `visible` defers the island's script, not its server-rendered markup.
      Component: () => h("main", null, h(Counter, { client: "visible" })),
      cssManifest: { [COUNTER_FILE]: ["/assets/counter.css"] },
    });

    expect(html).toContain('<link rel="stylesheet" href="/assets/counter.css">');
    // The island's chunk is still not preloaded — only its styles are hoisted.
    expect(html).not.toContain('rel="modulepreload" href="/assets/counter.js"');
  });

  it("does not repeat a stylesheet the route and the island share", () => {
    expect(
      withIslandCssAssets(
        [{ href: "/assets/shared.css" }, { href: "/assets/page.css" }],
        { [COUNTER_FILE]: ["/assets/shared.css", "/assets/counter.css"] },
        undefined,
        [COUNTER_FILE],
      ),
    ).toEqual([
      { href: "/assets/shared.css" },
      { href: "/assets/page.css" },
      { href: "/assets/counter.css" },
    ]);
  });

  it("leaves the page's assets alone when there is no CSS manifest", () => {
    const cssAssets = [{ href: "/assets/page.css" }];
    expect(withIslandCssAssets(cssAssets, undefined, undefined, [COUNTER_FILE])).toBe(cssAssets);
  });
});
