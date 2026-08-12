// @vitest-environment jsdom
import { h, hydrate, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  handlePrachtRequest,
  lazy,
  route,
  Suspense,
  type HeadMetadata,
} from "../src/index.ts";
import { _resetForTesting as resetHydrationForTesting, markHydrating } from "../src/hydration.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
} from "../src/islands-server.ts";
import {
  _resetScriptRegistryForTesting,
  Script,
  SCRIPT_INJECTED_ATTRIBUTE,
  SCRIPT_PLACEHOLDER_ATTRIBUTE,
  type ScriptProps,
} from "../src/script.ts";

let scratch: HTMLDivElement;

/** Flush microtasks, requestAnimationFrame, and Preact effect queues. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => setTimeout(r, 0));
}

function injectedScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>(`script[${SCRIPT_INJECTED_ATTRIBUTE}]`)];
}

async function renderRoute(options: {
  Component: (props: any) => any;
  head?: () => HeadMetadata;
  hydration?: "full" | "islands" | "none";
}): Promise<string> {
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
          ...(options.head ? { head: options.head } : {}),
        }),
      },
    },
    request: new Request("http://localhost/"),
    debugErrors: true,
  });

  return response.text();
}

beforeEach(() => {
  resetHydrationForTesting();
  _resetScriptRegistryForTesting();
  scratch = document.createElement("div");
  document.body.appendChild(scratch);
});

afterEach(() => {
  render(null, scratch);
  scratch.remove();
  for (const el of injectedScripts()) el.remove();
  for (const el of document.querySelectorAll("script")) el.remove();
  _resetIslandsForTesting();
  vi.restoreAllMocks();
});

describe("<Script> SSR emission", () => {
  it('emits strategy="beforeHydration" scripts into the document head', async () => {
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(Script, {
            strategy: "beforeHydration",
            src: "https://example.com/analytics.js",
            async: true,
          }),
        ),
    });

    const headEnd = html.indexOf("</head>");
    const scriptIndex = html.indexOf('<script src="https://example.com/analytics.js" async="">');
    expect(scriptIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(headEnd);
    // The component itself renders nothing into the body.
    const body = html.slice(html.indexOf("<body>"));
    expect(body).not.toContain("analytics.js");
  });

  it("emits inline beforeHydration children with script-safe escaping", async () => {
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(
            Script,
            { strategy: "beforeHydration", id: "flags" },
            'window.flags = { beta: true };\nconsole.log("</script>");',
          ),
        ),
    });

    expect(html).toContain('<script id="flags">');
    expect(html).toContain("window.flags = { beta: true };");
    // Closing tags inside the inline source cannot break out of the element.
    expect(html).toContain('console.log("</\\u0073cript>");');
    expect(html).not.toContain('console.log("</script>");');
  });

  it("keeps inline JavaScript with bare <, >, and && syntactically valid", async () => {
    // Real-world third-party snippets (Segment, GTM, …) contain bare `&&`
    // and comparison operators outside string literals. Full `\uXXXX`
    // escaping would turn them into syntax errors.
    const source = "window.console && console.error; if (1 < 2 && 3 > 2) { window.__ops = true; }";
    const html = await renderRoute({
      Component: () =>
        h("main", null, h(Script, { strategy: "beforeHydration", id: "ops" }, source)),
    });

    const inner = html.match(/<script id="ops">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(inner).toBe(source);
    // Emitted source must parse as JavaScript.
    expect(() => new Function(inner)).not.toThrow();
  });

  it("neutralizes every HTML parser breakout sequence while preserving JS semantics", async () => {
    const source = 'var probe = "</script><script>alert(1)</script>" + "<!--" + "<script>";';
    const html = await renderRoute({
      Component: () =>
        h("main", null, h(Script, { strategy: "beforeHydration", id: "breakout" }, source)),
    });

    const inner = html.match(/<script id="breakout">([\s\S]*?)<\/script>/)?.[1] ?? "";
    // No literal parser-significant sequence survives in the emitted text.
    expect(inner.toLowerCase()).not.toContain("</script>");
    expect(inner.toLowerCase()).not.toContain("<script>");
    expect(inner).not.toContain("<!--");
    // The escaping is a JS no-op inside string literals: evaluating the
    // emitted source yields the original string.
    const result = new Function(`${inner}; return probe;`)() as string;
    expect(result).toBe("</script><script>alert(1)</script>" + "<!--" + "<script>");
  });

  it("preserves regex and comparison semantics while neutralizing script tokens", async () => {
    const source = [
      'var regexProbe = /<script>/i.test("<SCRIPT>");',
      "var scriptLimit = 3; var comparisonProbe = 2<scriptLimit;",
      'var closingProbe = 0</script/.test("script");',
    ].join("\n");
    const html = await renderRoute({
      Component: () =>
        h("main", null, h(Script, { strategy: "beforeHydration", id: "tokens" }, source)),
    });

    const inner = html.match(/<script id="tokens">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(inner.toLowerCase()).not.toContain("<script");
    expect(inner.toLowerCase()).not.toContain("</script");
    const result = new Function(
      `${inner}; return { regexProbe, comparisonProbe, closingProbe };`,
    )();
    expect(result).toEqual({ regexProbe: true, comparisonProbe: true, closingProbe: true });
  });

  it("emits JSON script types with JSON-safe full escaping", async () => {
    const payload = JSON.stringify({ headline: "</script><script>alert(1)</script>" });
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(
            Script,
            { strategy: "beforeHydration", id: "ld", type: "application/ld+json" },
            payload,
          ),
        ),
    });

    const inner =
      html.match(/<script id="ld" type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(inner).toContain("\\u003c");
    expect(inner).not.toContain("</script>");
    // `\uXXXX` escapes are valid JSON: consumers can parse the text directly.
    expect((JSON.parse(inner) as { headline: string }).headline).toBe(
      "</script><script>alert(1)</script>",
    );
  });

  it("only passes allowlisted attributes through to SSR HTML (no on*)", async () => {
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(Script, {
            strategy: "beforeHydration",
            src: "/vendor.js",
            defer: true,
            type: "module",
            nonce: "abc123",
            integrity: "sha384-xyz",
            crossorigin: "anonymous",
            referrerpolicy: "no-referrer",
            // Client-only handlers must never serialize into HTML.
            onLoad: () => {},
            onError: () => {},
            // Arbitrary props are dropped entirely.
            ...({ onclick: "alert(1)" } as unknown as Partial<ScriptProps>),
          }),
        ),
    });

    const tag = html.match(/<script [^>]*src="\/vendor\.js"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('defer=""');
    expect(tag).toContain('type="module"');
    expect(tag).toContain('nonce="abc123"');
    expect(tag).toContain('integrity="sha384-xyz"');
    expect(tag).toContain('crossorigin="anonymous"');
    expect(tag).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("onLoad");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
  });

  it("dedupes identical beforeHydration scripts within a render", async () => {
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(Script, { strategy: "beforeHydration", src: "/once.js" }),
          h(Script, { strategy: "beforeHydration", src: "/once.js" }),
        ),
    });

    expect(html.match(/src="\/once\.js"/g)?.length).toBe(1);
  });

  it("dedupes captured beforeHydration scripts against head() metadata", async () => {
    const html = await renderRoute({
      head: () => ({ script: [{ src: "/once.js" }] }),
      Component: () => h("main", null, h(Script, { strategy: "beforeHydration", src: "/once.js" })),
    });

    expect(html.match(/src="\/once\.js"/g)?.length).toBe(1);
  });

  it("renders nothing server-side for client strategies", async () => {
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(Script, { strategy: "afterHydration", src: "/after.js" }),
          h(Script, { strategy: "idle", src: "/idle.js" }),
        ),
    });

    expect(html).not.toContain("/after.js");
    expect(html).not.toContain("/idle.js");
  });

  it('renders a placeholder marker for strategy="visible"', async () => {
    const html = await renderRoute({
      Component: () => h("main", null, h(Script, { strategy: "visible", src: "/visible.js" })),
    });

    expect(html).toContain(`${SCRIPT_PLACEHOLDER_ATTRIBUTE}="src:/visible.js"`);
    expect(html).not.toContain('<script src="/visible.js"');
  });

  it("renders the visible placeholder out of flow so it cannot disturb layout", async () => {
    // position:absolute at the static position: never splits inline content
    // (a block box would) and never becomes a flex/grid item consuming a
    // `gap` slot, while staying observable by IntersectionObserver.
    const html = await renderRoute({
      Component: () => h("main", null, h(Script, { strategy: "visible", src: "/visible.js" })),
    });

    const placeholder = html.match(
      new RegExp(`<span[^>]*${SCRIPT_PLACEHOLDER_ATTRIBUTE}[^>]*>`),
    )?.[0];
    expect(placeholder).toContain("position:absolute");
    expect(placeholder).not.toContain("display:block");
  });

  it("escapes attribute values so props cannot break out of the SSR tag", async () => {
    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(Script, {
            strategy: "beforeHydration",
            src: '/x.js" onload="alert(1)',
            id: '"><script>alert(2)</script>',
          }),
        ),
    });

    expect(html).not.toContain('onload="alert(1)"');
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&quot;");
  });

  it("escapes the visible placeholder key derived from src", async () => {
    const html = await renderRoute({
      Component: () =>
        h("main", null, h(Script, { strategy: "visible", src: '/x.js"><img onerror="alert(1)' })),
    });

    expect(html).not.toContain('"><img');
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it('emits beforeHydration scripts into the head on hydration: "islands" routes', async () => {
    const html = await renderRoute({
      hydration: "islands",
      Component: () =>
        h("main", null, h(Script, { strategy: "beforeHydration", src: "/islands-head.js" })),
    });

    const headEnd = html.indexOf("</head>");
    const scriptIndex = html.indexOf('<script src="/islands-head.js">');
    expect(scriptIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(headEnd);
  });

  it("warns when src and inline children are both set and ignores the inline content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = await renderRoute({
      Component: () =>
        h(
          "main",
          null,
          h(Script, { strategy: "beforeHydration", src: "/both.js" }, "window.__ignored = true;"),
        ),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("both"));
    expect(html).toContain('<script src="/both.js"></script>');
    expect(html).not.toContain("__ignored");
  });

  it('warns in dev when a client strategy renders on a hydration: "none" route', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await renderRoute({
      hydration: "none",
      Component: () => h("main", null, h(Script, { strategy: "afterHydration", src: "/never.js" })),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hydration: "none"'));
  });

  it('does not warn for beforeHydration on a hydration: "none" route', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = await renderRoute({
      hydration: "none",
      Component: () => h("main", null, h(Script, { strategy: "beforeHydration", src: "/ok.js" })),
    });

    expect(html).toContain('src="/ok.js"');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("<Script> client strategies", () => {
  it('injects strategy="afterHydration" scripts once hydration completes', async () => {
    render(h(Script, { src: "/after.js" }), scratch);
    await flush();

    const injected = injectedScripts();
    expect(injected.length).toBe(1);
    expect(injected[0].getAttribute("src")).toBe("/after.js");
    expect(injected[0].parentElement).toBe(document.head);
  });

  it("waits for suspended hydration before injecting afterHydration scripts", async () => {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    let suspended = false;
    function LazyChild() {
      if (!suspended) {
        suspended = true;
        throw promise;
      }
      return h("span", null, "ready");
    }
    function App() {
      return h(
        "div",
        null,
        h(Script, { src: "/after-suspense.js" }),
        h(Suspense, { fallback: null }, h(LazyChild, {})),
      );
    }

    scratch.innerHTML = "<div><span>ready</span></div>";
    markHydrating();
    hydrate(h(App, {}), scratch);
    await flush();
    const injectedWhilePending = injectedScripts().length;

    resolvePromise();
    await flush();

    expect(injectedWhilePending).toBe(0);
    expect(injectedScripts()).toHaveLength(1);
    expect(injectedScripts()[0].getAttribute("src")).toBe("/after-suspense.js");
  });

  it("sets allowlisted attributes and skips handlers on injected elements", async () => {
    render(
      h(Script, {
        src: "/attrs.js",
        id: "attrs",
        async: true,
        type: "module",
        nonce: "n0nce",
        integrity: "sha384-abc",
        crossorigin: "anonymous",
        referrerpolicy: "origin",
      }),
      scratch,
    );
    await flush();

    const el = document.getElementById("attrs");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("async")).toBe("");
    expect(el?.getAttribute("type")).toBe("module");
    expect(el?.getAttribute("nonce")).toBe("n0nce");
    expect(el?.getAttribute("integrity")).toBe("sha384-abc");
    expect(el?.getAttribute("crossorigin")).toBe("anonymous");
    expect(el?.getAttribute("referrerpolicy")).toBe("origin");
    expect(el?.getAttribute("onload")).toBeNull();
  });

  it("injects inline children as element text content", async () => {
    render(h(Script, { id: "inline" }, "window.__inline = 1;"), scratch);
    await flush();

    expect(document.getElementById("inline")?.textContent).toBe("window.__inline = 1;");
  });

  it("fires onLoad when an external script loads", async () => {
    const onLoad = vi.fn();
    render(h(Script, { src: "/load.js", onLoad }), scratch);
    await flush();

    injectedScripts()[0].dispatchEvent(new Event("load"));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("fires onError when an external script fails", async () => {
    const onError = vi.fn();
    render(h(Script, { src: "/fail.js", onError }), scratch);
    await flush();

    injectedScripts()[0].dispatchEvent(new Event("error"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("never injects the same script twice across re-renders and remounts", async () => {
    render(h(Script, { id: "once", src: "/once.js" }), scratch);
    await flush();
    render(null, scratch);
    render(h(Script, { id: "once", src: "/once.js" }), scratch);
    await flush();

    expect(injectedScripts().length).toBe(1);
  });

  it("registers server-emitted scripts instead of injecting them again", async () => {
    const existing = document.createElement("script");
    existing.setAttribute("src", "/ssr-emitted.js");
    document.head.appendChild(existing);

    render(h(Script, { strategy: "afterHydration", src: "/ssr-emitted.js" }), scratch);
    await flush();

    expect(injectedScripts().length).toBe(0);
    expect(document.querySelectorAll('script[src="/ssr-emitted.js"]').length).toBe(1);
  });

  it('injects strategy="idle" scripts via requestIdleCallback', async () => {
    const idleCallbacks: (() => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idleCallbacks.push(cb);
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", () => {});

    try {
      render(h(Script, { strategy: "idle", src: "/idle.js" }), scratch);
      await flush();

      expect(injectedScripts().length).toBe(0);
      for (const cb of idleCallbacks) cb();
      expect(injectedScripts().length).toBe(1);
      expect(injectedScripts()[0].getAttribute("src")).toBe("/idle.js");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to setTimeout for strategy="idle" without requestIdleCallback', async () => {
    vi.stubGlobal("requestIdleCallback", undefined);

    try {
      render(h(Script, { strategy: "idle", src: "/idle-fallback.js" }), scratch);
      await flush();
      // The fallback schedules a 200ms timeout.
      await new Promise<void>((r) => setTimeout(r, 300));

      expect(injectedScripts().length).toBe(1);
      expect(injectedScripts()[0].getAttribute("src")).toBe("/idle-fallback.js");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores inline children on injection when src is also set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(h(Script, { src: "/both-client.js" }, "window.__ignoredClient = true;"), scratch);
    await flush();

    const el = injectedScripts()[0];
    expect(el.getAttribute("src")).toBe("/both-client.js");
    expect(el.textContent).toBe("");
  });

  it('injects strategy="visible" scripts when the placeholder intersects', async () => {
    let intersectCallback: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          intersectCallback = cb;
        }
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {}
      },
    );

    try {
      render(h(Script, { strategy: "visible", src: "/visible.js" }), scratch);
      await flush();

      expect(scratch.querySelector(`[${SCRIPT_PLACEHOLDER_ATTRIBUTE}]`)).not.toBeNull();
      expect(observed.length).toBe(1);
      expect(injectedScripts().length).toBe(0);

      intersectCallback?.([{ isIntersecting: true }]);
      expect(injectedScripts().length).toBe(1);
      expect(injectedScripts()[0].getAttribute("src")).toBe("/visible.js");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to immediate injection for strategy="visible" without IntersectionObserver', async () => {
    // jsdom has no IntersectionObserver; the fallback mirrors islands.
    render(h(Script, { strategy: "visible", src: "/visible-fallback.js" }), scratch);
    await flush();

    expect(injectedScripts().length).toBe(1);
  });

  it("warns in dev when beforeHydration mounts without a server-emitted tag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(h(Script, { strategy: "beforeHydration", src: "/late.js" }), scratch);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("beforeHydration"));
    // The script is still injected so functionality does not silently drop.
    expect(injectedScripts().length).toBe(1);
  });

  it("throws on an invalid strategy", () => {
    expect(() =>
      render(h(Script, { strategy: "eager" as never, src: "/x.js" }), scratch),
    ).toThrowError(/invalid strategy/);
  });

  it("warns and renders nothing without src or inline children", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(h(Script, {}), scratch);
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("requires either"));
    expect(injectedScripts().length).toBe(0);
  });

  it("still injects when an unrelated element holds the same id", async () => {
    // A non-script element sharing the id must not be mistaken for an
    // already-present script tag.
    const decoy = document.createElement("div");
    decoy.id = "widget";
    document.body.appendChild(decoy);

    try {
      render(h(Script, { id: "widget", src: "/widget.js" }), scratch);
      await flush();

      expect(injectedScripts().length).toBe(1);
      expect(injectedScripts()[0].getAttribute("src")).toBe("/widget.js");
    } finally {
      decoy.remove();
    }
  });
});

describe('<Script> on hydration: "islands" routes', () => {
  function ServerCounter({ start = 0 }: { start?: number }) {
    return h("button", {}, `Count: ${start}`);
  }

  function registerTestIslands(): void {
    registerServerIslands({ "/src/islands/ServerCounter.tsx": { default: ServerCounter } });
    setIslandsClientEntryUrl("/assets/islands-client-test.js");
  }

  it("warns in dev for client strategies outside any island (they can never run)", async () => {
    registerTestIslands();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await renderRoute({
      hydration: "islands",
      Component: () =>
        h(
          "main",
          null,
          h(ServerCounter, { start: 1 }),
          h(Script, { strategy: "afterHydration", src: "/static-region.js" }),
        ),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("outside any island"));
  });

  it("does not warn for client strategies inside an island (they hydrate)", async () => {
    registerTestIslands();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function IslandWithScript({ start = 0 }: { start?: number }) {
      return h(
        "div",
        null,
        `Count: ${start}`,
        h(Script, { strategy: "afterHydration", src: "/inside-island.js" }),
      );
    }
    registerServerIslands({ "/src/islands/IslandWithScript.tsx": { default: IslandWithScript } });

    await renderRoute({
      hydration: "islands",
      Component: () => h("main", null, h(IslandWithScript, { start: 2 })),
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("captures beforeHydration scripts from inside an island into the head", async () => {
    registerTestIslands();

    function IslandWithBefore() {
      return h("div", null, h(Script, { strategy: "beforeHydration", src: "/island-before.js" }));
    }
    registerServerIslands({ "/src/islands/IslandWithBefore.tsx": { default: IslandWithBefore } });

    const html = await renderRoute({
      hydration: "islands",
      Component: () => h("main", null, h(IslandWithBefore, {})),
    });

    const headEnd = html.indexOf("</head>");
    const scriptIndex = html.indexOf('<script src="/island-before.js">');
    expect(scriptIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(headEnd);
  });
});

describe("<Script> capture isolation and Suspense", () => {
  it("captures beforeHydration scripts from a Suspense boundary that resolves late", async () => {
    const Late = lazy(
      () =>
        new Promise<{ default: () => ReturnType<typeof h> }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                default: () => h(Script, { strategy: "beforeHydration", src: "/late-suspense.js" }),
              }),
            10,
          ),
        ),
    );

    const html = await renderRoute({
      Component: () => h("main", null, h(Suspense, { fallback: null }, h(Late, {}))),
    });

    const headEnd = html.indexOf("</head>");
    const scriptIndex = html.indexOf('<script src="/late-suspense.js">');
    expect(scriptIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(headEnd);
  });

  it("keeps concurrent server renders from cross-contaminating captures", async () => {
    // Two interleaved async renders (the parallel-SSG-prerender shape): each
    // suspends mid-render so their lifetimes overlap, and each must only see
    // its own beforeHydration script.
    const lateComponent = (src: string, delay: number) =>
      lazy(
        () =>
          new Promise<{ default: () => ReturnType<typeof h> }>((resolve) =>
            setTimeout(
              () => resolve({ default: () => h(Script, { strategy: "beforeHydration", src }) }),
              delay,
            ),
          ),
      );
    const LateA = lateComponent("/page-a.js", 20);
    const LateB = lateComponent("/page-b.js", 5);

    const renderPage = (path: string, Late: typeof LateA) => {
      const app = defineApp({
        routes: [route(path, "./routes/page.tsx", { render: "ssr" })],
      });
      return handlePrachtRequest({
        app,
        registry: {
          routeModules: {
            "./routes/page.tsx": async () => ({
              Component: () => h("main", null, h(Suspense, { fallback: null }, h(Late, {}))),
            }),
          },
        },
        request: new Request(`http://localhost${path}`),
        debugErrors: true,
      }).then((response) => response.text());
    };

    const [htmlA, htmlB] = await Promise.all([renderPage("/a", LateA), renderPage("/b", LateB)]);

    expect(htmlA).toContain('<script src="/page-a.js">');
    expect(htmlA).not.toContain("/page-b.js");
    expect(htmlB).toContain('<script src="/page-b.js">');
    expect(htmlB).not.toContain("/page-a.js");
  });
});
