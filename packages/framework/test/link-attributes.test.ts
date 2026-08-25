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

  it("rejects a passed href even when route is present", () => {
    expect(() => renderLink({ href: "https://evil.example/" })).toThrow(
      /navigates by route id, not href/,
    );
  });

  it("rejects a passed href during SSR even when route is present", () => {
    expect(() =>
      renderToString(h(Link, { route: "logout", href: "https://evil.example/" } as never)),
    ).toThrow(/navigates by route id, not href/);
  });
});
