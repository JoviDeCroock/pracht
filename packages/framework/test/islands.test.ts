import { createContext, Fragment, h } from "preact";
import { useContext } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import { defineApp, group, handlePrachtRequest, resolveApp, route } from "../src/index.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
  validateIslandProps,
} from "../src/islands-server.ts";

afterEach(() => {
  _resetIslandsForTesting();
});

function Counter({ start = 0 }: { start?: number }) {
  return h("button", { onClick: () => {} }, `Count: ${start}`);
}

function Nested() {
  return h("span", null, "nested");
}

function registerTestIslands(): void {
  registerServerIslands({
    "/src/islands/Counter.tsx": { default: Counter },
    "/src/islands/Nested.tsx": { Nested },
  });
  setIslandsClientEntryUrl("/assets/islands-client-test.js");
}

const testWebmcpCapability = defineCapability({
  title: "Search notes",
  description: "Find matching notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  expose: { http: true, webmcp: true },
  async run() {
    return {};
  },
});

interface RenderRouteOptions {
  capabilities?: string[];
  Component: (props: any) => any;
  ErrorBoundary?: (props: any) => any;
  hydration?: "full" | "islands" | "none";
  islandsBootstrapRequired?: boolean;
  islandsEntryUrl?: string;
  loader?: () => unknown;
  speculation?: "prefetch" | "prerender";
}

async function renderRoute(options: RenderRouteOptions): Promise<string> {
  const app = defineApp({
    capabilities: options.capabilities?.length
      ? Object.fromEntries(options.capabilities.map((name) => [name, `./capabilities/${name}.ts`]))
      : undefined,
    routes: [
      route("/", "./routes/page.tsx", {
        capabilities: options.capabilities,
        render: "ssr",
        ...(options.hydration ? { hydration: options.hydration } : {}),
        ...(options.speculation ? { speculation: options.speculation } : {}),
      }),
    ],
  });

  const response = await handlePrachtRequest({
    app,
    registry: {
      routeModules: {
        "./routes/page.tsx": async () => ({
          Component: options.Component,
          ...(options.ErrorBoundary ? { ErrorBoundary: options.ErrorBoundary } : {}),
          ...(options.loader ? { loader: options.loader } : {}),
        }),
      },
      capabilityModules: options.capabilities?.length
        ? Object.fromEntries(
            options.capabilities.map((name) => [
              `./capabilities/${name}.ts`,
              async () => ({ default: testWebmcpCapability }),
            ]),
          )
        : undefined,
    },
    request: new Request("http://localhost/"),
    debugErrors: true,
    islandsBootstrapRequired: options.islandsBootstrapRequired,
    islandsEntryUrl: options.islandsEntryUrl,
  });

  return response.text();
}

describe("islands route config", () => {
  it("inherits hydration mode from groups", () => {
    const app = defineApp({
      routes: [
        group({ hydration: "islands" }, [
          route("/a", "./routes/a.tsx", { render: "ssg" }),
          route("/b", "./routes/b.tsx", { render: "ssg", hydration: "none" }),
        ]),
        route("/c", "./routes/c.tsx", { render: "ssg" }),
      ],
    });

    const resolved = resolveApp(app);
    expect(resolved.routes.find((r) => r.path === "/a")?.hydration).toBe("islands");
    expect(resolved.routes.find((r) => r.path === "/b")?.hydration).toBe("none");
    expect(resolved.routes.find((r) => r.path === "/c")?.hydration).toBeUndefined();
  });

  it("rejects spa render combined with islands hydration", () => {
    const app = defineApp({
      routes: [
        route("/settings", "./routes/settings.tsx", { render: "spa", hydration: "islands" }),
      ],
    });

    expect(() => resolveApp(app)).toThrowError(/render: "spa" with hydration: "islands"/);
  });

  it("allows spa render with explicit full hydration", () => {
    const app = defineApp({
      routes: [route("/settings", "./routes/settings.tsx", { render: "spa", hydration: "full" })],
    });

    expect(() => resolveApp(app)).not.toThrow();
  });
});

describe("islands server rendering", () => {
  it("wraps islands in markers with serialized props on islands routes", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h("main", null, h(Counter, { start: 5 })),
    });

    expect(html).toContain('<pracht-island island="/src/islands/Counter.tsx" export="default"');
    expect(html).toContain('props="{&quot;start&quot;:5}"');
    expect(html).toContain("Count: 5");
    // No hydration state and no full client runtime — only the islands bootstrap.
    expect(html).not.toContain('id="pracht-state"');
    expect(html).toContain('<script type="module" src="/assets/islands-client-test.js"></script>');
  });

  it("omits the props attribute for empty props and adds the strategy attribute", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h(Counter, { client: "visible" } as never),
    });

    expect(html).toContain('client="visible"');
    expect(html).not.toContain("props=");
  });

  it("does not emit markers or scripts on hydration none routes without islands", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "none",
      Component: () => h("main", null, "static"),
    });

    expect(html).not.toContain("<pracht-island");
    expect(html).not.toContain("<script");
  });

  it("can emit speculation rules without adding hydration scripts", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "none",
      speculation: "prefetch",
      Component: () => h("main", null, "static"),
    });

    expect(html).not.toContain('id="pracht-state"');
    expect(html).toContain('<script type="speculationrules">');
  });

  it("skips the app-level WebMCP bootstrap when the route activates no tools", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      islandsBootstrapRequired: true,
      Component: () => h("main", null, "no islands here"),
    });

    expect(html).not.toContain("<pracht-island");
    expect(html).not.toContain('<script type="module"');
  });

  it("keeps the bootstrap when a zero-island response owns a page-level projection", async () => {
    registerTestIslands();

    const html = await renderRoute({
      capabilities: ["notes.search"],
      hydration: "islands",
      islandsBootstrapRequired: true,
      Component: () => h("main", null, "agent tools without UI islands"),
    });

    expect(html).not.toContain("<pracht-island");
    expect(html).toContain(
      '<script type="module" src="/assets/islands-client-test.js" data-pracht-webmcp-tools="notes.search"></script>',
    );
  });

  it("keeps hydration none script-free even when another projection needs the islands entry", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "none",
      islandsBootstrapRequired: true,
      Component: () => h("main", null, "deliberately zero JavaScript"),
    });

    expect(html).not.toContain("<script");
  });

  it("fails closed when a required zero-island bootstrap URL is missing", async () => {
    const html = await renderRoute({
      capabilities: ["notes.search"],
      hydration: "islands",
      islandsBootstrapRequired: true,
      Component: () => h("main", null, "agent tools"),
    });

    expect(html).toContain("requires the islands bootstrap");
    expect(html).toContain("page-level runtime projection");
    expect(html).toContain("no bootstrap URL is registered");
  });

  it("keeps per-app bootstrap requirements and URLs isolated", async () => {
    setIslandsClientEntryUrl("/assets/global-should-not-win.js");
    const [agentHtml, staticHtml] = await Promise.all([
      renderRoute({
        capabilities: ["notes.search"],
        hydration: "islands",
        islandsBootstrapRequired: true,
        islandsEntryUrl: "/assets/app-a-agent.js",
        Component: () => h("main", null, "app a"),
      }),
      renderRoute({
        hydration: "islands",
        islandsBootstrapRequired: false,
        islandsEntryUrl: "/assets/app-b-islands.js",
        Component: () => h("main", null, "app b"),
      }),
    ]);

    expect(agentHtml).toContain("/assets/app-a-agent.js");
    expect(agentHtml).not.toContain("global-should-not-win");
    expect(staticHtml).not.toContain("<script");
  });

  it("renders islands as plain components on full-hydration routes", async () => {
    registerTestIslands();

    const html = await renderRoute({
      Component: () => h("main", null, h(Counter, { start: 2 })),
    });

    expect(html).not.toContain("<pracht-island");
    expect(html).toContain("Count: 2");
    expect(html).toContain('id="pracht-state"');
  });

  it("does not emit nested markers for islands inside islands", async () => {
    function Outer() {
      return h("div", null, h(Nested, {}));
    }
    registerServerIslands({
      "/src/islands/Outer.tsx": { default: Outer },
      "/src/islands/Nested.tsx": { Nested },
    });
    setIslandsClientEntryUrl("/assets/islands-client-test.js");

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h(Outer, {}),
    });

    expect(html.match(/<pracht-island/g)).toHaveLength(1);
    expect(html).toContain('island="/src/islands/Outer.tsx"');
    expect(html).toContain("nested");
  });

  it("throws a clear error for non-serializable props", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h(Counter, { onSelect: () => {} } as never),
    });

    expect(html).toContain("props.onSelect is a function");
  });

  it("throws a clear error for an invalid client strategy", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h(Counter, { client: "eager" } as never),
    });

    expect(html).toContain("invalid client strategy");
  });

  it("keeps hydration none error boundaries script-free", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "none",
      loader: () => {
        throw new Error("Broken static page");
      },
      Component: () => h("main", null, "ok"),
      ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
    });

    expect(html).toContain("Error: Broken static page");
    expect(html).not.toContain('id="pracht-state"');
    expect(html).not.toContain("<script");
  });

  it("uses the islands bootstrap for islands error boundaries that render islands", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      loader: () => {
        throw new Error("Broken islands page");
      },
      Component: () => h("main", null, "ok"),
      ErrorBoundary: () => h("section", null, h(Counter, { start: 7 })),
    });

    expect(html).toContain('<pracht-island island="/src/islands/Counter.tsx" export="default"');
    expect(html).toContain('props="{&quot;start&quot;:7}"');
    expect(html).not.toContain('id="pracht-state"');
    expect(html).toContain('<script type="module" src="/assets/islands-client-test.js"></script>');
    expect(html).not.toContain("/@pracht/client.js");
  });

  it("keeps the bootstrap for zero-island error boundaries with a page-level projection", async () => {
    registerTestIslands();
    const html = await renderRoute({
      capabilities: ["notes.search"],
      hydration: "islands",
      islandsBootstrapRequired: true,
      loader: () => {
        throw new Error("Broken agent page");
      },
      Component: () => h("main", null, "ok"),
      ErrorBoundary: () => h("section", null, "agent-safe fallback"),
    });

    expect(html).toContain("agent-safe fallback");
    expect(html).not.toContain("<pracht-island");
    expect(html).toContain("/assets/islands-client-test.js");
  });
});

describe("island children", () => {
  const SLOT_END = "<!--/pracht-slot-->";

  async function renderIslandPage(
    islands: Record<string, (props: any) => any>,
    Component: () => any,
  ): Promise<string> {
    registerServerIslands(
      Object.fromEntries(
        Object.entries(islands).map(([name, component]) => [
          `/src/islands/${name}.tsx`,
          { default: component },
        ]),
      ),
    );
    setIslandsClientEntryUrl("/assets/islands-client-test.js");
    return renderRoute({ hydration: "islands", Component });
  }

  function Box({ children }: { children?: unknown }) {
    return h("div", null, children as never);
  }

  it("renders children inside a slot closed by an end marker, outside the props", async () => {
    function Titled({ title, children }: { title: string; children?: unknown }) {
      return h("section", null, h("h2", null, title), children as never);
    }
    const html = await renderIslandPage({ Titled }, () =>
      h(Titled as never, { title: "Hi" }, h("p", null, "server content")),
    );

    expect(html).toContain(
      `<section><h2>Hi</h2><pracht-slot style="display:contents"><p>server content</p>${SLOT_END}</pracht-slot></section>`,
    );
    expect(html).toContain('props="{&quot;title&quot;:&quot;Hi&quot;}"');
    expect(html).not.toContain("<template");
  });

  it("gives islands inside an island's children their own markers", async () => {
    const html = await renderIslandPage({ Box, Counter }, () =>
      h(Box as never, {}, h(Counter, { start: 2 })),
    );

    expect(html.match(/<pracht-island/g)).toHaveLength(2);
    expect(html).toMatch(
      /<pracht-slot style="display:contents"><pracht-island island="\/src\/islands\/Counter.tsx"[^>]*props="\{&quot;start&quot;:2\}"/,
    );
  });

  it("ships children an island does not place in a template", async () => {
    function Disclosure({ children }: { children?: unknown }) {
      const open = false;
      return h("div", null, h("button", null, "More"), open ? (children as never) : null);
    }
    const html = await renderIslandPage({ Disclosure }, () =>
      h(Disclosure as never, {}, h("p", null, "hidden content")),
    );

    expect(html).toContain(
      `<div><button>More</button></div><template pracht-slot><p>hidden content</p>${SLOT_END}</template>`,
    );
    expect(html).not.toContain("<pracht-slot");
  });

  it("passes text children through the props instead of a slot, joined into one string", async () => {
    const html = await renderIslandPage({ Box }, () =>
      h(Box as never, {}, "npm i ", "pracht", false, [null, "@", 2]),
    );

    expect(html).toContain("<div>npm i pracht@2</div>");
    expect(html).toContain('props="{&quot;children&quot;:&quot;npm i pracht@2&quot;}"');
    expect(html).not.toContain("pracht-slot");

    const single = await renderIslandPage({ Box }, () => h(Box as never, {}, 42));
    expect(single).toContain('props="{&quot;children&quot;:42}"');
  });

  it("passes no slot for children that render nothing", async () => {
    function Probe({ children }: { children?: unknown }) {
      return h("div", null, children === undefined ? "none" : "some");
    }
    const html = await renderIslandPage({ Probe }, () => h(Probe as never, {}, false, null));

    expect(html).toContain("<div>none</div>");
    expect(html).not.toContain("pracht-slot");
  });

  it("uses an SVG group as the slot inside SVG and a MathML row inside MathML", async () => {
    function Chart({ children }: { children?: unknown }) {
      return h("svg", null, h("g", null, children as never));
    }
    function Formula({ children }: { children?: unknown }) {
      return h("math", null, children as never);
    }
    const svg = await renderIslandPage({ Chart }, () =>
      h(Chart as never, {}, h("circle", { r: 4 })),
    );
    expect(svg).toContain(
      `<svg><g><g pracht-slot><circle r="4"></circle>${SLOT_END}</g></g></svg>`,
    );

    const math = await renderIslandPage({ Formula }, () =>
      h(Formula as never, {}, h("mi", null, "x")),
    );
    expect(math).toContain(`<math><mrow pracht-slot><mi>x</mi>${SLOT_END}</mrow></math>`);
  });

  it("throws a clear error for a render function as children, also inside an array", async () => {
    for (const children of [() => "x", [() => "x"]]) {
      const html = await renderIslandPage({ Box }, () => h(Box as never, {}, children as never));
      expect(html).toContain('Island "Box" (/src/islands/Box.tsx) received a function as children');
    }
  });

  it("rejects slots the HTML parser cannot keep where the island puts them", async () => {
    const cases: [string, (props: { children?: unknown }) => any, unknown, string][] = [
      [
        "Rows",
        ({ children }) => h("table", null, h("tbody", null, children as never)),
        h("tr", null, h("td", null, "cell")),
        "directly inside <tbody>",
      ],
      [
        "Pick",
        ({ children }) => h("select", null, h("option", null, h("span", null, children as never))),
        h("b", null, "Alpha"),
        "inside <option>",
      ],
      [
        "Notes",
        ({ children }) => h("textarea", null, children as never),
        h("b", null, "text"),
        "inside <textarea>",
      ],
      [
        "Details",
        ({ children }) => h("details", null, children as never),
        [h("summary", null, "Summary"), h("p", null, "body")],
        "including a <summary> that must come first",
      ],
      [
        "Group",
        ({ children }) => h("fieldset", null, children as never),
        h("legend", null, "Legend"),
        "including a <legend> that must come first",
      ],
      [
        "Wrapped",
        ({ children }) => h("details", null, children as never),
        h(Fragment, null, h("summary", null, "Summary"), h("p", null, "body")),
        "including a <summary> that must come first",
      ],
      [
        "Player",
        ({ children }) => h("video", { controls: true }, children as never),
        [h("source", { src: "/a.mp4" }), h("track", { kind: "captions", src: "/a.vtt" })],
        "directly inside <video>",
      ],
      [
        "Sound",
        ({ children }) => h("audio", null, children as never),
        h("source", { src: "/a.ogg" }),
        "directly inside <audio>",
      ],
      [
        "Art",
        ({ children }) => h("picture", null, children as never, h("img", { alt: "" })),
        h("source", { srcset: "/a.avif" }),
        "directly inside <picture>",
      ],
      [
        "Reading",
        ({ children }) => h("ruby", null, children as never),
        ["漢", h("rt", null, "kan")],
        "directly inside <ruby>",
      ],
      [
        "Label",
        ({ children }) => h("svg", null, h("text", null, children as never)),
        h("tspan", null, "label"),
        "directly inside <text>",
      ],
      [
        "Clip",
        ({ children }) => h("svg", null, h("clipPath", null, children as never)),
        h("circle", { r: 4 }),
        "directly inside <clipPath>",
      ],
      [
        "Fraction",
        ({ children }) => h("math", null, h("mfrac", null, children as never)),
        [h("mi", null, "a"), h("mi", null, "b")],
        "directly inside <mfrac>",
      ],
    ];

    for (const [name, island, children, reason] of cases) {
      const html = await renderIslandPage({ [name]: island }, () =>
        h(island as never, {}, children as never),
      );
      expect(html, name).toContain(
        `Island "${name}" (/src/islands/${name}.tsx) renders its children`,
      );
      expect(html, name).toContain(reason);
    }
  });

  it("rejects in dev children the HTML parser would move out of a <p>, <a>, or <button>", async () => {
    const cases: [string, (props: { children?: unknown }) => any, () => unknown, string][] = [
      [
        "Lead",
        ({ children }) => h("p", null, h("span", null, children as never)),
        () => h("div", null, "block"),
        "renders its children inside <p>, and they contain a <div>",
      ],
      [
        "Card",
        ({ children }) => h("a", { href: "/card" }, children as never),
        () =>
          h(function Link() {
            return h("em", null, h("a", { href: "/x" }, "x"));
          }, null),
        "renders its children inside <a>, and they contain another <a>",
      ],
      [
        "Action",
        ({ children }) => h("button", null, children as never),
        () => h("button", null, "inner"),
        "renders its children inside <button>, and they contain another <button>",
      ],
    ];
    for (const [name, island, children, reason] of cases) {
      const html = await renderIslandPage({ [name]: island }, () =>
        h(island as never, {}, children() as never),
      );
      expect(html, name).toContain(`Island "${name}" (/src/islands/${name}.tsx) ${reason}`);
    }

    // A <p> around the island counts too, but not one inside the children,
    // behind a <button> or table cell, or with no island in between.
    function Inline({ children }: { children?: unknown }) {
      return h("span", null, children as never);
    }
    const outside = await renderIslandPage({ Inline }, () =>
      h("p", null, h(Inline as never, {}, h("ul", null, h("li", null, "x")))),
    );
    expect(outside).toContain(
      'Island "Inline" (/src/islands/Inline.tsx) renders its children inside <p>',
    );
    function Para({ children }: { children?: unknown }) {
      return h(
        "p",
        null,
        h("button", null, children as never),
        h("table", null, h("tbody", null, h("tr", null, h("td", null, h("div", null, "cell"))))),
      );
    }
    const fine = await renderIslandPage({ Para }, () =>
      h("div", null, h(Para as never, {}, h("div", null, h("p", null, h("div", null, "inner"))))),
    );
    expect(fine).toContain("<button><pracht-slot");
    expect(fine).not.toContain("renders its children");
    // A <p> the island's own block element already closed is not the slot's.
    const closedEarlier = await renderIslandPage({ Box }, () =>
      h("p", null, h(Box as never, {}, h("div", null, "x"))),
    );
    expect(closedEarlier).not.toContain("renders its children");
    const plain = await renderIslandPage({ Box }, () => h("p", null, h("div", null, "no island")));
    expect(plain).not.toContain("renders its children");
  });

  it("accepts children inside a table cell and a details body after the island's summary", async () => {
    function Cell({ children }: { children?: unknown }) {
      return h("table", null, h("tbody", null, h("tr", null, h("td", null, children as never))));
    }
    function Disclosure({ children }: { children?: unknown }) {
      return h("details", null, h("summary", null, "More"), children as never);
    }
    const cell = await renderIslandPage({ Cell }, () => h(Cell as never, {}, h("b", null, "x")));
    expect(cell).toContain('<td><pracht-slot style="display:contents"><b>x</b>');

    const details = await renderIslandPage({ Disclosure }, () =>
      h(Disclosure as never, {}, h("p", null, "body")),
    );
    expect(details).toContain(
      '<details><summary>More</summary><pracht-slot style="display:contents"><p>body</p>',
    );
  });

  it("warns once when context an island provides around its children cannot reach an island inside them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Theme = createContext("light");
    function Tabs({ children }: { children?: unknown }) {
      return h(Theme.Provider, { value: "dark" }, h("div", null, children as never));
    }
    function Panel() {
      return h("span", null, useContext(Theme));
    }

    await renderIslandPage({ Tabs, Panel }, () => h(Tabs as never, {}, h(Panel, {})));
    await renderIslandPage({ Tabs, Panel }, () => h(Tabs as never, {}, h(Panel, {})));
    const contextWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes("provides context around its children"),
    );
    expect(contextWarnings).toHaveLength(1);
    expect(contextWarnings[0][0]).toContain('Island "Tabs" (/src/islands/Tabs.tsx)');

    warn.mockClear();
    await renderIslandPage({ Tabs }, () => h(Tabs as never, {}, h("p", null, "static")));
    await renderIslandPage({ Box, Panel }, () => h(Box as never, {}, h(Panel, {})));
    expect(warn.mock.calls.some(([message]) => String(message).includes("provides context"))).toBe(
      false,
    );
  });
});

describe("validateIslandProps", () => {
  const descriptor = { file: "/src/islands/Counter.tsx", name: "Counter" };

  it("accepts JSON-serializable values", () => {
    expect(() =>
      validateIslandProps(
        {
          text: "hello",
          count: 3,
          enabled: true,
          nothing: null,
          missing: undefined,
          list: [1, "two", { three: 3 }],
          nested: { deep: { ok: true } },
        },
        descriptor,
      ),
    ).not.toThrow();
  });

  it("rejects functions with a path in the message", () => {
    expect(() => validateIslandProps({ onClick: () => {} }, descriptor)).toThrowError(
      /props\.onClick is a function/,
    );
  });

  it("rejects nested non-serializable values with the full path", () => {
    expect(() =>
      validateIslandProps({ config: { handlers: [() => {}] } }, descriptor),
    ).toThrowError(/props\.config\.handlers\[0\] is a function/);
  });

  it("rejects undefined inside arrays", () => {
    expect(() => validateIslandProps({ list: [1, undefined] }, descriptor)).toThrowError(
      /props\.list\[1\] is undefined inside an array/,
    );
  });

  it("rejects non-finite numbers", () => {
    expect(() => validateIslandProps({ value: Number.NaN }, descriptor)).toThrowError(
      /props\.value is NaN/,
    );
  });

  it("rejects class instances", () => {
    expect(() => validateIslandProps({ when: new Date() }, descriptor)).toThrowError(
      /props\.when is a Date instance/,
    );
  });

  it("rejects bigints and symbols", () => {
    expect(() => validateIslandProps({ big: 1n }, descriptor)).toThrowError(
      /props\.big is a bigint/,
    );
    expect(() => validateIslandProps({ sym: Symbol("x") }, descriptor)).toThrowError(
      /props\.sym is a symbol/,
    );
  });

  it("rejects JSX elements", () => {
    expect(() => validateIslandProps({ slot: h("div", null) }, descriptor)).toThrowError(
      /props\.slot is a JSX element/,
    );
  });

  it("rejects circular references", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => validateIslandProps({ value }, descriptor)).toThrowError(/circular reference/);
  });
});
