// @vitest-environment jsdom
import { h, hydrate, render } from "preact";
import { Suspense } from "preact-suspense";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markHydrating, useIsHydrated, _resetForTesting } from "../src/hydration.ts";

let scratch: HTMLDivElement;

function setupScratch() {
  scratch = document.createElement("div");
  document.body.appendChild(scratch);
  return scratch;
}

/** Flush microtasks, requestAnimationFrame, and Preact re-renders. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("useIsHydrated", () => {
  beforeEach(() => {
    _resetForTesting();
    setupScratch();
  });

  afterEach(() => {
    if (scratch) {
      render(null, scratch);
      scratch.remove();
    }
  });

  it("returns false during the initial hydration render", () => {
    scratch.innerHTML = "<div>hello</div>";

    const values: boolean[] = [];
    function App() {
      values.push(useIsHydrated());
      return h("div", null, "hello");
    }

    markHydrating();
    hydrate(h(App, null), scratch);

    expect(values[0]).toBe(false);
  });

  it("returns true after hydration completes (no suspensions)", async () => {
    scratch.innerHTML = "<div>hello</div>";

    const values: boolean[] = [];
    function App() {
      values.push(useIsHydrated());
      return h("div", null, "hello");
    }

    markHydrating();
    hydrate(h(App, null), scratch);
    await flush();

    expect(values[values.length - 1]).toBe(true);
  });

  it("returns false when markHydrating was never called", () => {
    const values: boolean[] = [];
    function App() {
      values.push(useIsHydrated());
      return h("div", null, "hello");
    }

    render(h(App, null), scratch);
    expect(values[0]).toBe(false);
  });

  it("starts true for components mounting after hydration finished", async () => {
    scratch.innerHTML = "<div>hello</div>";

    function First() {
      return h("div", null, "hello");
    }
    markHydrating();
    hydrate(h(First, null), scratch);
    await flush();

    // Mount a new component after hydration — should start with true
    const values: boolean[] = [];
    function Second() {
      values.push(useIsHydrated());
      return h("div", null, "world");
    }
    render(h(Second, null), scratch);

    expect(values[0]).toBe(true);
  });

  it("keeps sibling components consistent during the initial hydration render", () => {
    // Regression: a per-vnode `options.diffed` flip would fire _hydrated=true
    // after the first sibling's subtree finished diffing, causing the second
    // sibling to read `true` from `useState(_hydrated)` during its very first
    // render — mid-tree inconsistency between siblings in the same hydrate
    // call. Using `options.__c` (commit root) defers the flip to after the
    // whole tree commits, so both siblings must observe `false` on render 1.
    scratch.innerHTML = "<div><div>A</div><div>B</div></div>";

    const valuesA: boolean[] = [];
    const valuesB: boolean[] = [];
    function A() {
      valuesA.push(useIsHydrated());
      return h("div", null, "A");
    }
    function B() {
      valuesB.push(useIsHydrated());
      return h("div", null, "B");
    }
    function Root() {
      return h("div", null, h(A, null), h(B, null));
    }

    markHydrating();
    hydrate(h(Root, null), scratch);

    expect(valuesA[0]).toBe(false);
    expect(valuesB[0]).toBe(false);
  });

  it("flips _hydrated exactly once for the whole initial commit", async () => {
    // Sanity check that deeper nesting doesn't re-trigger the flip. All
    // descendants in a single hydrate call should see `false` on render 1 and
    // `true` on render 2 (after useEffect), and a component mounted afterwards
    // via a subsequent render() should see `true` immediately.
    scratch.innerHTML = "<div><div><div>leaf</div></div></div>";

    const leafValues: boolean[] = [];
    function Leaf() {
      leafValues.push(useIsHydrated());
      return h("div", null, "leaf");
    }
    function Middle() {
      return h("div", null, h(Leaf, null));
    }
    function Root() {
      return h("div", null, h(Middle, null));
    }

    markHydrating();
    hydrate(h(Root, null), scratch);

    expect(leafValues[0]).toBe(false);

    await flush();

    expect(leafValues[leafValues.length - 1]).toBe(true);

    // Subsequent mount picks up the finished state synchronously.
    const laterValues: boolean[] = [];
    function Later() {
      laterValues.push(useIsHydrated());
      return h("div", null, "later");
    }
    render(h(Later, null), scratch);
    expect(laterValues[0]).toBe(true);
  });

  it("tracks suspension count during hydration", async () => {
    // SSR rendered the *resolved* content — that's what sits in the DOM.
    // During hydration the lazy component throws a promise; Suspense keeps
    // the server HTML alive (no fallback shown). The global _hydrated flag
    // stays false until the promise settles, so components that mount
    // later (e.g. via lazy()) get the correct initial value.
    scratch.innerHTML = "<div><div>Hello</div></div>";

    let resolvePromise!: () => void;
    const promise = new Promise<void>((r) => {
      resolvePromise = r;
    });

    let threw = false;
    const lazyValues: boolean[] = [];
    function LazyChild() {
      if (!threw) {
        threw = true;
        throw promise;
      }
      lazyValues.push(useIsHydrated());
      return h("div", null, "Hello");
    }

    const rootValues: boolean[] = [];
    function Root() {
      rootValues.push(useIsHydrated());
      return h(Suspense as any, { fallback: h("div", null, "Loading...") }, h(LazyChild, null));
    }

    markHydrating();
    hydrate(h(Root, null), scratch);

    // During hydration render — _hydrated is false so useState initialises to false
    expect(rootValues[0]).toBe(false);
    // LazyChild threw, so it never called the hook yet
    expect(lazyValues).toHaveLength(0);

    await flush();

    // Root's useEffect has fired
    expect(rootValues[rootValues.length - 1]).toBe(true);

    // Server HTML is still visible (Suspense didn't swap to fallback)
    expect(scratch.innerHTML).toContain("Hello");

    // Resolve the lazy component — LazyChild renders for the first time,
    // _hydrated is still false at that point so useState initialises to false.
    resolvePromise();
    await flush();

    // LazyChild's first render saw _hydrated=false, then useEffect flipped it
    expect(lazyValues[0]).toBe(false);
    expect(lazyValues[lazyValues.length - 1]).toBe(true);
  });

  it("does not count suspensions thrown from non-hydrating render() trees", async () => {
    // Regression: while a hydrate is still waiting on a legitimate
    // hydration-suspension, other parts of the app can mount unrelated
    // trees via render() — e.g. a portal, a modal root, a parallel
    // island. If one of those throws a promise, its vnode does NOT carry
    // MODE_HYDRATE (only hydrate() sets that flag), so it's a regular
    // render-cycle suspension, not a hydration-suspension. Our __e must
    // ignore it, otherwise the global `_hydrated` flag would stay
    // pinned at false even after the real hydration finishes.
    //
    // We probe the GLOBAL `_hydrated` flag (not a component's local
    // useState) by mounting a fresh component after the scenario — its
    // initial `useState(_hydrated)` reads the global directly.
    scratch.innerHTML = "<div>hello</div>";

    let hydrateThrew = false;
    let resolveHydrate!: () => void;
    const hydratePromise = new Promise<void>((r) => {
      resolveHydrate = r;
    });
    function HydrateLazy() {
      if (!hydrateThrew) {
        hydrateThrew = true;
        throw hydratePromise;
      }
      return h("div", null, "hello");
    }

    markHydrating();
    hydrate(h(Suspense as any, { fallback: null }, h(HydrateLazy, null)), scratch);
    // After this, _hydrating=true, _hydrated=false, _suspensionCount=1
    // (from HydrateLazy's legitimate hydration throw).

    // Mount an UNRELATED tree via render() that also throws. Its vnodes
    // have no MODE_HYDRATE flag — if the guard in __e is missing, this
    // would push _suspensionCount to 2 and `resolveHydrate()` below
    // would decrement it back to 1 (not 0), so `_hydrated` would never
    // flip.
    const otherScratch = document.createElement("div");
    document.body.appendChild(otherScratch);
    let otherThrew = false;
    // Intentionally never resolves — stays pending for the whole test.
    const otherPromise = new Promise<void>(() => {});
    function OtherLazy() {
      if (!otherThrew) {
        otherThrew = true;
        throw otherPromise;
      }
      return h("div", null, "other");
    }
    render(h(Suspense as any, { fallback: null }, h(OtherLazy, null)), otherScratch);

    // Resolve the real hydration suspension. With the guard working,
    // count goes 1 → 0 → next commit flips _hydrated=true.
    resolveHydrate();
    await flush();

    // Probe the global flag with a third, brand-new mount.
    const probeScratch = document.createElement("div");
    document.body.appendChild(probeScratch);
    try {
      const probeValues: boolean[] = [];
      function Probe() {
        probeValues.push(useIsHydrated());
        return h("div", null, "probe");
      }
      render(h(Probe, null), probeScratch);
      expect(probeValues[0]).toBe(true);
    } finally {
      render(null, otherScratch);
      otherScratch.remove();
      probeScratch.remove();
    }
  });
});
