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
        routes: [
          route("/logout", "./routes/logout.tsx", { id: "logout", render: "ssr" }),
          route("/posts/:id", "./routes/post.tsx", { id: "post", render: "ssr" }),
        ],
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

  it("removes router attributes a re-render turns off", () => {
    expect(renderLink({ preserveScroll: true, viewTransition: true }).outerHTML).toContain(
      "data-pracht-preserve-scroll",
    );

    const anchor = renderLink({ preserveScroll: false });
    expect(anchor.hasAttribute("data-pracht-preserve-scroll")).toBe(false);
    expect(anchor.hasAttribute("data-pracht-view-transition")).toBe(false);
  });

  it("server-renders anchor props and href without unset router attributes", () => {
    expect(
      renderToString(
        h(Link, {
          class: "nav",
          "data-x": "1",
          route: "post",
          params: { id: "a-1_b.c~" },
        } as never),
      ),
    ).toBe('<a data-x="1" href="/posts/a-1_b.c~" class="nav"></a>');
  });

  it("server-renders params that need escaping", () => {
    expect(renderToString(h(Link, { route: "post", params: { id: "é /?#&" } } as never))).toBe(
      `<a href="/posts/${encodeURIComponent("é /?#&")}"></a>`,
    );
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
