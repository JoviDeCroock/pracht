// @vitest-environment jsdom
import { h, hydrate, render } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StaticHtml, serverOnly } from "../src/index.ts";
import { stripServerOnlyValues } from "../src/server-only-strip.ts";

const MARKUP = '<h1 id="title">Data Loading</h1><p>Loaders run on the server.</p>';

let scratch: HTMLDivElement;

beforeEach(() => {
  scratch = document.createElement("div");
  document.body.appendChild(scratch);
});

afterEach(() => {
  render(null, scratch);
  scratch.remove();
});

/** What the browser holds for a marked field on the initial document. */
function strippedHtml() {
  return stripServerOnlyValues({ html: serverOnly(MARKUP) }).html;
}

describe("<StaticHtml>", () => {
  it("adopts server-rendered markup instead of re-creating it during hydration", () => {
    scratch.innerHTML = `<div class="prose">${MARKUP}</div>`;
    const adopted = scratch.querySelector("#title");

    hydrate(h(StaticHtml, { html: strippedHtml(), class: "prose" }), scratch);

    expect(scratch.querySelector(".prose")?.innerHTML).toBe(MARKUP);
    // The same nodes, not equivalent ones: nothing was torn down and rebuilt.
    expect(scratch.querySelector("#title")).toBe(adopted);
  });

  it("keeps the adopted markup across a re-render after hydration", () => {
    scratch.innerHTML = `<div><div class="prose">${MARKUP}</div></div>`;
    let bump: (() => void) | undefined;

    function Page() {
      const [count, setCount] = useState(0);
      bump = () => setCount(count + 1);
      return h(
        "div",
        null,
        h(StaticHtml, { html: strippedHtml(), class: "prose" }),
        h("span", null, String(count)),
      );
    }

    hydrate(h(Page, null), scratch);
    bump?.();

    expect(scratch.querySelector(".prose")?.innerHTML).toBe(MARKUP);
  });

  it("renders the markup on a client-side navigation, where the value is real", () => {
    render(h(StaticHtml, { html: MARKUP, class: "prose" }), scratch);
    expect(scratch.querySelector(".prose")?.innerHTML).toBe(MARKUP);
  });

  it("unwraps a serverOnly() value during the server render", () => {
    render(h(StaticHtml, { html: serverOnly(MARKUP) }), scratch);
    expect(scratch.firstElementChild?.innerHTML).toBe(MARKUP);
  });

  it("renders the requested element and forwards attributes", () => {
    render(h(StaticHtml, { html: MARKUP, as: "article", id: "post", "data-x": "1" }), scratch);
    const element = scratch.firstElementChild as HTMLElement;
    expect(element.tagName).toBe("ARTICLE");
    expect(element.id).toBe("post");
    expect(element.getAttribute("data-x")).toBe("1");
  });

  it("rejects a missing value rather than rendering an empty boundary", () => {
    expect(() => render(h(StaticHtml, { html: undefined as unknown as string }), scratch)).toThrow(
      /expects a string or serverOnly\(string\)/,
    );
  });

  it("rejects a component as `as`, which could not carry adopted markup", () => {
    expect(() =>
      render(h(StaticHtml, { html: MARKUP, as: (() => null) as unknown as string }), scratch),
    ).toThrow(/intrinsic tag name/);
  });
});
