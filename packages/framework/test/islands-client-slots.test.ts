// @vitest-environment jsdom
import { h } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import { hydrateIslands } from "../src/islands-client.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
} from "../src/islands-server.ts";

type Islands = Record<string, (props: any) => any>;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let show: (open: boolean) => void;

function Toggle({ children }: { children?: ComponentChildren }) {
  const [open, setOpen] = useState(true);
  show = setOpen;
  return h("div", { id: "toggle" }, open ? children : null);
}

function Closed({ children }: { children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  show = setOpen;
  return h("div", { id: "closed" }, open ? children : null);
}

function Counter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return h("button", { id: "count", onClick: () => setCount((c) => c + 1) }, String(count));
}

/** Server-render `page` on an islands route and load the HTML into the document. */
async function serverRender(islands: Islands, page: () => any): Promise<void> {
  registerServerIslands(
    Object.fromEntries(
      Object.entries(islands).map(([name, component]) => [
        `/src/islands/${name}.tsx`,
        { default: component },
      ]),
    ),
  );
  setIslandsClientEntryUrl("/assets/islands-client-test.js");
  const response = await handlePrachtRequest({
    app: defineApp({
      routes: [route("/", "./routes/page.tsx", { render: "ssr", hydration: "islands" })],
    }),
    registry: { routeModules: { "./routes/page.tsx": async () => ({ Component: page }) } },
    request: new Request("http://localhost/"),
    debugErrors: true,
  });
  const html = await response.text();
  document.body.innerHTML = html
    .match(/<body>([\s\S]*)<\/body>/)![1]
    .replace(/<script[\s\S]*?<\/script>/g, "");
}

async function hydrate(islands: Islands): Promise<void> {
  await hydrateIslands({
    modules: Object.fromEntries(
      Object.entries(islands).map(([name, component]) => [
        `/src/islands/${name}.tsx`,
        async () => ({ default: component }),
      ]),
    ),
  });
}

async function toggle(): Promise<void> {
  show(false);
  await tick();
  show(true);
  await tick();
}

function click(id: string): Promise<void> {
  document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return tick();
}

afterEach(() => {
  _resetIslandsForTesting();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("island children", () => {
  it("hydrates around the server-rendered children and restores them after a toggle", async () => {
    await serverRender({ Toggle }, () =>
      h(Toggle, {}, h("p", { id: "content" }, "server ", h("b", null, "content"))),
    );
    const content = document.getElementById("content");

    await hydrate({ Toggle });
    expect(document.getElementById("content")).toBe(content);

    show(false);
    await tick();
    expect(document.getElementById("content")).toBeNull();
    show(true);
    await tick();
    expect(document.getElementById("content")).toBe(content);
    expect(content!.innerHTML).toBe("server <b>content</b>");
    expect(document.querySelector<HTMLElement>("pracht-slot")!.style.display).toBe("contents");
  });

  it("keeps an island inside the children hydrated and stateful across a re-mount", async () => {
    await serverRender({ Toggle, Counter }, () => h(Toggle, {}, h(Counter, { start: 2 })));

    await hydrate({ Toggle, Counter });
    expect(document.querySelectorAll('[data-hydrated="true"]')).toHaveLength(2);
    await click("count");
    await toggle();
    expect(document.getElementById("count")!.textContent).toBe("3");
    await click("count");
    expect(document.getElementById("count")!.textContent).toBe("4");
  });

  it("shows children the island did not place on the server once it renders them", async () => {
    await serverRender({ Closed, Counter }, () =>
      h(Closed, {}, h("p", { id: "content" }, "later"), h(Counter, { start: 2 })),
    );

    await hydrate({ Closed, Counter });
    expect(document.querySelector("template")).toBeNull();
    expect(document.getElementById("content")).toBeNull();

    show(true);
    await tick();
    expect(document.getElementById("content")!.textContent).toBe("later");
    // The island inside the template was inert until now; it hydrates on show.
    await tick();
    await click("count");
    expect(document.getElementById("count")!.textContent).toBe("3");
  });

  it("restores the children as they are now, including changes made after hydration", async () => {
    await serverRender({ Toggle }, () =>
      h(Toggle, {}, h("blockquote", null, "embed placeholder"), h("p", null, "tail")),
    );
    await hydrate({ Toggle });

    // An embed script replaces its placeholder after the page loads.
    const iframe = document.createElement("iframe");
    document.querySelector("blockquote")!.replaceWith(iframe);
    await toggle();

    expect(document.querySelector("#toggle iframe")).toBe(iframe);
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("restores each copy of children rendered twice and keeps a keyed re-mount's nodes", async () => {
    let setKey: (key: number) => void = () => {};
    function Twice({ children }: { children?: ComponentChildren }) {
      const [open, setOpen] = useState(true);
      const [key, setKeyState] = useState(0);
      show = setOpen;
      setKey = setKeyState;
      return h(
        "div",
        { id: "twice" },
        open ? [h("i", { key: `a${key}` }, children), h("b", { key: "b" }, children)] : null,
      );
    }
    await serverRender({ Twice }, () => h(Twice, {}, h("p", { class: "c" }, "C")));
    const [first, second] = document.querySelectorAll("p.c");

    await hydrate({ Twice });
    await toggle();
    let copies = document.querySelectorAll("p.c");
    expect([copies[0], copies[1]]).toEqual([first, second]);

    setKey(1);
    await tick();
    copies = document.querySelectorAll("p.c");
    expect(copies).toHaveLength(2);
    expect(copies[0]).toBe(first);
  });

  it("leaves slots owned by a nested island to that island", async () => {
    let showInner: (open: boolean) => void = () => {};
    function Inner({ children }: { children?: ComponentChildren }) {
      const [open, setOpen] = useState(true);
      showInner = setOpen;
      return h("section", null, open ? children : null);
    }
    await serverRender({ Toggle, Inner }, () =>
      h(Toggle, {}, h(Inner, {}, h("p", { id: "inner" }, "inner"))),
    );
    const inner = document.getElementById("inner");

    await hydrate({ Toggle, Inner });
    await toggle();
    showInner(false);
    await tick();
    showInner(true);
    await tick();
    expect(document.getElementById("inner")).toBe(inner);
  });

  it("passes text children through as a plain value", async () => {
    function Copy({ children }: { children?: string }) {
      return h("button", { id: "copy", title: children }, children);
    }
    const pkg = "pracht";
    await serverRender({ Copy }, () => h(Copy as never, {}, "npm i ", pkg));
    expect(document.querySelector("pracht-slot")).toBeNull();

    await hydrate({ Copy });
    const button = document.getElementById("copy")!;
    expect(button.getAttribute("title")).toBe("npm i pracht");
    expect(button.textContent).toBe("npm i pracht");
  });

  it("keeps SVG children in an SVG group element", async () => {
    function Chart({ children }: { children?: ComponentChildren }) {
      const [open, setOpen] = useState(true);
      show = setOpen;
      return h("svg", { viewBox: "0 0 10 10" }, open ? children : null);
    }
    await serverRender({ Chart }, () => h(Chart, {}, h("circle", { id: "dot", r: 4 })));
    const dot = document.getElementById("dot")!;
    expect(dot.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(dot.parentElement!.localName).toBe("g");

    await hydrate({ Chart });
    await toggle();
    expect(document.getElementById("dot")).toBe(dot);
    expect(dot.parentElement!.localName).toBe("g");
    expect(dot.parentElement!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("observes the children's boxes for a visible island that renders only its children", async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {}
      },
    );
    function Bare({ children }: { children?: ComponentChildren }) {
      return children;
    }
    await serverRender({ Bare }, () =>
      h(Bare as never, { client: "visible" }, h("p", { id: "boxed" }, "content")),
    );

    await hydrate({ Bare });
    expect(observed).toEqual([document.getElementById("boxed")]);
  });

  it("observes the parent of a visible island whose only children are hidden", async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {}
      },
    );
    function Lazy({ children }: { children?: ComponentChildren }) {
      const [open] = useState(false);
      return open ? children : null;
    }
    await serverRender({ Lazy }, () =>
      h("section", { id: "host" }, h(Lazy as never, { client: "visible" }, h("p", null, "later"))),
    );

    await hydrate({ Lazy });
    expect(observed).toEqual([document.getElementById("host")]);
  });

  it("hydrates when nodes follow the end marker inside the slot", async () => {
    await serverRender({ Toggle }, () => h(Toggle, {}, h("p", { id: "content" }, "content")));
    // A widget script appended its output, and a formatter added whitespace.
    const slot = document.querySelector("pracht-slot")!;
    slot.append(document.createTextNode("\n  "), document.createElement("aside"));

    await hydrate({ Toggle });
    expect(document.querySelector("pracht-island")!.getAttribute("data-hydrated")).toBe("true");
    await toggle();
    expect(document.querySelector("#toggle aside")).not.toBeNull();
  });

  it("reports children first shown inside SVG that the server did not place", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    function Chart({ children }: { children?: ComponentChildren }) {
      const [open, setOpen] = useState(false);
      show = setOpen;
      return h("svg", null, open ? children : null);
    }
    await serverRender({ Chart }, () => h(Chart as never, {}, h("circle", { r: 4 })));

    await hydrate({ Chart });
    show(true);
    await tick();
    expect(
      error.mock.calls.some(([message]) =>
        String(message).includes("were not placed on the server"),
      ),
    ).toBe(true);
  });
});

describe("island children the HTML parser moved", () => {
  async function expectLeftUnhydrated(island: (props: any) => any, page: () => any) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverRender({ Island: island }, page);
    const before = document.body.innerHTML;

    await hydrate({ Island: island });

    expect(document.querySelector("pracht-island")!.hasAttribute("data-hydrated")).toBe(false);
    expect(document.body.innerHTML).toBe(before);
    expect(error.mock.calls[0][0]).toContain("the HTML parser moved its children");
  }

  it("leaves an island alone when block children were hoisted out of a <p>", async () => {
    function Lead({ children }: { children?: ComponentChildren }) {
      return h("div", null, h("p", null, children), h("span", null, "after"));
    }
    await expectLeftUnhydrated(Lead, () =>
      h(Lead, {}, h("div", { id: "block" }, "Block"), h("ul", null, h("li", null, "item"))),
    );
    expect(document.getElementById("block")).not.toBeNull();
  });

  it("leaves an island alone when raw HTML in its children closes the slot early", async () => {
    function Raw({ children }: { children?: ComponentChildren }) {
      return h("section", null, children);
    }
    await expectLeftUnhydrated(Raw, () =>
      h(
        Raw,
        {},
        h("article", { dangerouslySetInnerHTML: { __html: "<p>one</p></div><p>two</p>" } }),
      ),
    );
  });

  it("leaves an island alone when raw HTML in hidden children closes the template", async () => {
    // Never places its children, so they ship in a <template>.
    function Hidden(_props: { children?: ComponentChildren }) {
      return h("div", null, "closed");
    }
    await expectLeftUnhydrated(Hidden, () =>
      h(
        Hidden,
        {},
        h("div", { dangerouslySetInnerHTML: { __html: "<p>md</p></template><p>x</p>" } }),
      ),
    );
  });
});
