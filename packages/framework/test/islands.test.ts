import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";

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

interface RenderRouteOptions {
  Component: (props: any) => any;
  hydration?: "full" | "islands" | "none";
  loader?: () => unknown;
}

async function renderRoute(options: RenderRouteOptions): Promise<string> {
  const app = defineApp({
    routes: [
      route("/", "./routes/page.tsx", {
        render: "ssr",
        ...(options.hydration ? { hydration: options.hydration } : {}),
      }),
    ],
  });

  const response = await handlePrachtRequest({
    app,
    registry: {
      routeModules: {
        "./routes/page.tsx": async () => ({
          Component: options.Component,
          ...(options.loader ? { loader: options.loader } : {}),
        }),
      },
    },
    request: new Request("http://localhost/"),
    debugErrors: true,
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

  it("skips the bootstrap script when an islands route renders no islands", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h("main", null, "no islands here"),
    });

    expect(html).not.toContain("<pracht-island");
    expect(html).not.toContain('<script type="module"');
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

  it("throws a clear error when an island receives children", async () => {
    registerTestIslands();

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h(Counter as never, {}, h("span", null, "slot")),
    });

    expect(html).toContain("received children from a server component");
    expect(html).toContain("not supported in v1");
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
