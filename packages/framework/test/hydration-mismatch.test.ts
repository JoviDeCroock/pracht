// @vitest-environment jsdom
import { Fragment, h, hydrate, options as preactOptions, render } from "preact";
import type { VNode } from "preact";
import { Suspense, lazy } from "preact-suspense";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetHydrationMismatchForTesting,
  installHydrationMismatchWarning,
} from "../src/hydration-mismatch.ts";
import {
  _resetForTesting as _resetHydrationStateForTesting,
  markHydrating,
} from "../src/hydration.ts";

const BANNER_ID = "__pracht_hydration_mismatch__";

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("installHydrationMismatchWarning", () => {
  let scratch: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    scratch = document.createElement("div");
    document.body.appendChild(scratch);
    _resetHydrationMismatchForTesting();
    _resetHydrationStateForTesting();
  });

  afterEach(() => {
    if (scratch.isConnected) {
      render(null, scratch);
      scratch.remove();
    }
    _resetHydrationMismatchForTesting();
    _resetHydrationStateForTesting();
  });

  it("appends a visible banner with the component name when Preact reports a hydration mismatch", () => {
    installHydrationMismatchWarning();

    function Profile() {
      return h("span", null, "client");
    }

    const vnode = h(Profile, null) as unknown as VNode;
    (preactOptions as { __m?: (vnode: VNode) => void }).__m!(vnode);

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Profile");
    expect(banner!.textContent).toContain("Hydration mismatch");
    expect(banner!.getAttribute("role")).toBe("alert");
  });

  it("chains to a previously installed __m hook", () => {
    const calls: VNode[] = [];
    (preactOptions as { __m?: (vnode: VNode) => void }).__m = (vnode) => {
      calls.push(vnode);
    };

    installHydrationMismatchWarning();

    const vnode = h("div", null) as unknown as VNode;
    (preactOptions as { __m?: (vnode: VNode) => void }).__m!(vnode);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(vnode);
    expect(document.getElementById(BANNER_ID)).not.toBeNull();
  });

  it("only installs the hook once across repeated calls", () => {
    installHydrationMismatchWarning();
    const firstHook = (preactOptions as { __m?: (vnode: VNode) => void }).__m;

    installHydrationMismatchWarning();
    const secondHook = (preactOptions as { __m?: (vnode: VNode) => void }).__m;

    expect(secondHook).toBe(firstHook);
  });

  it("appends additional mismatches as list items in the existing banner", () => {
    installHydrationMismatchWarning();

    const m = (preactOptions as { __m?: (vnode: VNode) => void }).__m!;
    m(h("div", null) as unknown as VNode);
    m(h("span", null) as unknown as VNode);

    const banner = document.getElementById(BANNER_ID)!;
    const items = banner.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("div");
    expect(items[1].textContent).toContain("span");
  });

  it("surfaces the banner on a real hydration mismatch", () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<section>server</section>";

    function App() {
      return h("article", null, "client");
    }

    hydrate(h(App, null), scratch);

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Hydration mismatch");
  });

  it("does not warn when a component unsuspends during hydration with exactly one DOM node", async () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<div><div>Resolved</div></div>";

    let resolvePromise!: () => void;
    const promise = new Promise<void>((r) => {
      resolvePromise = r;
    });
    let threw = false;

    function LazyChild() {
      if (!threw) {
        threw = true;
        throw promise;
      }
      return h("div", null, "Resolved");
    }

    function App() {
      return h(Suspense as any, { fallback: null }, h(LazyChild, null));
    }

    markHydrating();
    hydrate(h(App, null), scratch);

    resolvePromise();
    await flush();

    const banner = document.getElementById(BANNER_ID);
    expect(banner).toBeNull();
  });

  it("warns when a component unsuspends during hydration and renders multiple DOM nodes", async () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<div><div>A</div><div>B</div></div>";

    let resolvePromise!: () => void;
    const promise = new Promise<void>((r) => {
      resolvePromise = r;
    });
    let threw = false;

    function FragmentChild() {
      if (!threw) {
        threw = true;
        throw promise;
      }
      return h(Fragment, null, h("div", null, "A"), h("div", null, "B"));
    }

    function App() {
      return h(Suspense as any, { fallback: null }, h(FragmentChild, null));
    }

    markHydrating();
    hydrate(h(App, null), scratch);

    resolvePromise();
    await flush();

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Suspense boundary resolved during hydration");
    expect(banner!.textContent).toContain("rendered 2 DOM nodes");
  });

  it("warns when a component unsuspends during hydration and renders zero DOM nodes", async () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<div></div>";

    let resolvePromise!: () => void;
    const promise = new Promise<void>((r) => {
      resolvePromise = r;
    });
    let threw = false;

    function EmptyChild() {
      if (!threw) {
        threw = true;
        throw promise;
      }
      return null;
    }

    function App() {
      return h(Suspense as any, { fallback: null }, h(EmptyChild, null));
    }

    markHydrating();
    hydrate(h(App, null), scratch);

    resolvePromise();
    await flush();

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Suspense boundary resolved during hydration");
    expect(banner!.textContent).toContain("rendered 0 DOM nodes");
  });

  it("reports the resolved user component name, not the lazy() wrapper, on offset issues", async () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<div><div>A</div><div>B</div></div>";

    let resolveImport!: (mod: { default: typeof BadlyShapedPage }) => void;
    const importPromise = new Promise<{ default: typeof BadlyShapedPage }>((r) => {
      resolveImport = r;
    });

    function BadlyShapedPage() {
      return h(Fragment, null, h("div", null, "A"), h("div", null, "B"));
    }

    const LazyPage = lazy(() => importPromise);

    function App() {
      return h(Suspense as any, { fallback: null }, h(LazyPage as any, null));
    }

    markHydrating();
    hydrate(h(App, null), scratch);

    resolveImport({ default: BadlyShapedPage });
    await flush();

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("rendered 2 DOM nodes");
    expect(banner!.textContent).toContain("BadlyShapedPage");
    expect(banner!.textContent).not.toContain("<Lazy>");
  });

  it("handles wrapper components between the Suspense boundary and the suspending component", async () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<div><div>A</div><div>B</div></div>";

    let resolveImport!: (mod: { default: typeof BadDeepLeaf }) => void;
    const importPromise = new Promise<{ default: typeof BadDeepLeaf }>((r) => {
      resolveImport = r;
    });

    function BadDeepLeaf() {
      return h(Fragment, null, h("div", null, "A"), h("div", null, "B"));
    }
    const LazyDeepLeaf = lazy(() => importPromise);

    function InnerWrapper(props: { children?: unknown }) {
      return props.children as any;
    }
    function OuterWrapper(props: { children?: unknown }) {
      return props.children as any;
    }
    function App() {
      return h(
        Suspense as any,
        { fallback: null },
        h(OuterWrapper, null, h(InnerWrapper, null, h(LazyDeepLeaf as any, null))),
      );
    }

    markHydrating();
    hydrate(h(App, null), scratch);

    resolveImport({ default: BadDeepLeaf });
    await flush();

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("rendered 2 DOM nodes");
    expect(banner!.textContent).toContain("BadDeepLeaf");
    expect(banner!.textContent).not.toContain("<Lazy>");
  });

  it("does not warn for promises thrown outside of the hydration phase", async () => {
    installHydrationMismatchWarning();

    let resolvePromise!: () => void;
    const promise = new Promise<void>((r) => {
      resolvePromise = r;
    });
    let threw = false;

    function FragmentChild() {
      if (!threw) {
        threw = true;
        throw promise;
      }
      return h(Fragment, null, h("div", null, "A"), h("div", null, "B"));
    }

    function App() {
      return h(Suspense as any, { fallback: null }, h(FragmentChild, null));
    }

    // Plain render() — no MODE_HYDRATE on the vnodes.
    render(h(App, null), scratch);

    resolvePromise();
    await flush();

    const banner = document.getElementById(BANNER_ID);
    expect(banner).toBeNull();
  });
});
