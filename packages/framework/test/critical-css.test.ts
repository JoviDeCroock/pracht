import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import { buildHtmlDocument } from "../src/runtime-html.ts";
import { resolvePageCssAssets } from "../src/runtime-manifest.ts";

describe("inlined route CSS", () => {
  it("partitions inlined assets from linked fallbacks without changing route order", () => {
    expect(
      resolvePageCssAssets(
        {
          "./shell.tsx": ["/assets/shared.css", "/assets/shell.css"],
          "./route.tsx": ["/assets/shared.css", "/assets/route.css"],
        },
        {
          "/assets/shared.css": ".shared{}",
          "/assets/route.css": ".route{}",
        },
        "./shell.tsx",
        "./route.tsx",
      ),
    ).toEqual([
      { content: ".shared{}", href: "/assets/shared.css" },
      { href: "/assets/shell.css" },
      { content: ".route{}", href: "/assets/route.css" },
    ]);
  });

  it("renders nonce-bearing inline CSS safely and omits its stylesheet link", () => {
    const html = buildHtmlDocument({
      head: { styleNonce: 'nonce"value' },
      body: "<p>hello</p>",
      cssAssets: [
        {
          content: '.hero::after{content:"</style><script>bad()</script>"}',
          href: "/assets/inline.css",
        },
        { href: "/assets/fallback.css" },
        { content: ".after{display:block}", href: "/assets/after.css" },
      ],
    });

    expect(html).toContain(
      '<style data-pracht-inline-css nonce="nonce&quot;value">.hero::after{content:"<\\/style><script>bad()</script>"}</style>',
    );
    expect(html).toContain('<link rel="stylesheet" href="/assets/fallback.css">');
    expect(html.indexOf("<\\/style><script>bad()")).toBeLessThan(
      html.indexOf('href="/assets/fallback.css"'),
    );
    expect(html.indexOf('href="/assets/fallback.css"')).toBeLessThan(
      html.indexOf(".after{display:block}"),
    );
    expect(html).not.toContain("</style><script>bad()</script>");
  });

  it.each([
    ["spa", "full"],
    ["ssr", "full"],
    ["ssg", "none"],
    ["isg", "islands"],
  ] as const)("uses the same CSS path for %s/%s documents", async (render, hydration) => {
    const file = "./routes/home.tsx";
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/", file, { hydration, render })] }),
      registry: {
        routeModules: {
          [file]: async () => ({ Component: () => h("main", null, "Hello") }),
        },
      },
      request: new Request("http://localhost/"),
      clientEntryUrl: hydration === "full" ? "/assets/client.js" : undefined,
      cssManifest: { [file]: ["/assets/home.css"] },
      cssContentManifest: { "/assets/home.css": ".home{color:rebeccapurple}" },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<style data-pracht-inline-css>.home{color:rebeccapurple}</style>");
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("keeps inlined CSS on rendered error boundaries", async () => {
    const file = "./routes/error.tsx";
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/", file, { render: "ssr" })] }),
      registry: {
        routeModules: {
          [file]: async () => ({
            Component: () => {
              throw new Error("boom");
            },
            ErrorBoundary: () => h("main", null, "Recovered"),
          }),
        },
      },
      request: new Request("http://localhost/"),
      cssManifest: { [file]: ["/assets/error.css"] },
      cssContentManifest: { "/assets/error.css": ".error{color:red}" },
    });
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(html).toContain("Recovered");
    expect(html).toContain("<style data-pracht-inline-css>.error{color:red}</style>");
  });
});
