import { createHash } from "node:crypto";

import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import { buildHtmlDocument, VIEW_TRANSITION_CSS } from "../src/runtime-html.ts";
import type { HeadMetadata, HydrationMode, RenderMode } from "../src/types.ts";

const VIEW_TRANSITION_TAG = `<style data-pracht-view-transitions>${VIEW_TRANSITION_CSS}</style>`;

async function renderPage(options: {
  hydration: HydrationMode;
  render?: RenderMode;
  viewTransitions?: boolean;
  head?: HeadMetadata;
}): Promise<string> {
  const file = "./routes/home.tsx";
  const response = await handlePrachtRequest({
    app: defineApp({
      routes: [route("/", file, { hydration: options.hydration, render: options.render ?? "ssr" })],
      viewTransitions: options.viewTransitions,
    }),
    registry: {
      routeModules: {
        [file]: async () => ({
          Component: () => h("main", null, "Hello"),
          head: options.head ? () => options.head! : undefined,
        }),
      },
    },
    request: new Request("http://localhost/"),
    clientEntryUrl: options.hydration === "full" ? "/assets/client.js" : undefined,
    cssManifest: { [file]: ["/assets/home.css"] },
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("cross-document view transitions", () => {
  it("is the navigation: auto at-rule with the documented CSP hash", () => {
    expect(VIEW_TRANSITION_CSS).toBe("@view-transition{navigation:auto}");
    // Published in the view transitions and CSP docs for nonce-less pages.
    expect(createHash("sha256").update(VIEW_TRANSITION_CSS).digest("base64")).toBe(
      "SREix9zPMZHrSuo8zRSjb672r1gsHIh96MJuaZq6iJo=",
    );
  });

  it.each([
    ["ssr", "none"],
    ["ssg", "none"],
    ["ssr", "islands"],
    ["isg", "islands"],
    ["ssr", "full"],
    ["spa", "full"],
  ] as const)(
    "emits the at-rule on %s/%s documents when enabled app-wide",
    async (render, hydration) => {
      const html = await renderPage({ render, hydration, viewTransitions: true });
      expect(html).toContain(VIEW_TRANSITION_TAG);
      // Ahead of route CSS, so an app stylesheet can override it.
      expect(html.indexOf(VIEW_TRANSITION_TAG)).toBeLessThan(
        html.indexOf('href="/assets/home.css"'),
      );
    },
  );

  it.each(["none", "islands", "full"] as const)(
    "omits the at-rule on %s documents by default",
    async (hydration) => {
      const html = await renderPage({ hydration });
      expect(html).not.toContain("@view-transition");
    },
  );

  it("adds no script to a hydration: none document", async () => {
    const html = await renderPage({ hydration: "none", viewTransitions: true });
    expect(html).not.toContain("<script");
  });

  it("carries the route styleNonce", async () => {
    const html = await renderPage({
      hydration: "islands",
      viewTransitions: true,
      head: { styleNonce: 'abc"123' },
    });
    expect(html).toContain(
      `<style data-pracht-view-transitions nonce="abc&quot;123">${VIEW_TRANSITION_CSS}</style>`,
    );
  });

  it("is off unless requested when building a document directly", () => {
    expect(buildHtmlDocument({ head: {}, body: "" })).not.toContain("@view-transition");
    expect(buildHtmlDocument({ head: {}, body: "", viewTransitions: true })).toContain(
      VIEW_TRANSITION_TAG,
    );
  });
});
