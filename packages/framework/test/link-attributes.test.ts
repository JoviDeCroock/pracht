// @vitest-environment jsdom
import { h, render } from "preact";
import renderToString from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineApp, Link, resolveApp, route } from "../src/index.ts";

describe("<Link> data attributes", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    const app = resolveApp(
      defineApp({
        routes: [route("/logout", "./routes/logout.tsx", { id: "logout", render: "ssr" })],
      }),
    );
    globalThis.__PRACHT_ROUTE_DEFINITIONS__ = app.routes;
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  });

  function renderLink(props: Record<string, unknown>): HTMLAnchorElement {
    render(h(Link, { route: "logout", ...props } as never, "Log out"), root);
    return root.querySelector("a") as HTMLAnchorElement;
  }

  it("omits the speculate attribute when the prop is unset", () => {
    expect(renderLink({}).hasAttribute("data-pracht-speculate")).toBe(false);
  });

  it("renders speculate={false} as an opt-out", () => {
    expect(renderLink({ speculate: false }).getAttribute("data-pracht-speculate")).toBe("off");
  });

  it("renders speculate as a re-opt-in inside an off scope", () => {
    expect(renderLink({ speculate: true }).getAttribute("data-pracht-speculate")).toBe("on");
  });

  it("keeps the speculate and prefetch opt-outs independent", () => {
    const anchor = renderLink({ speculate: false, prefetch: "none" });
    expect(anchor.getAttribute("data-pracht-speculate")).toBe("off");
    expect(anchor.getAttribute("data-pracht-prefetch")).toBe("none");
  });

  // `href` is a declared prop only so the compiler error can carry the fix; it
  // is never destructured, so it rides along in the rest spread. The computed
  // href is assigned after that spread and has to win, on every render path.
  it("never lets a passed href reach the anchor", () => {
    expect(renderLink({ href: "https://evil.example/" }).getAttribute("href")).toBe("/logout");
  });

  it("never lets a passed href reach the anchor during SSR", () => {
    const html = renderToString(
      h(Link, { route: "logout", href: "https://evil.example/" } as never),
    );
    expect(html).toContain('href="/logout"');
    expect(html).not.toContain("evil.example");
  });
});
