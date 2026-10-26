// @vitest-environment jsdom
import { Component, Fragment, h, hydrate, render, type VNode } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test loads fresh framework modules: the gate and the defer registry
// are page-lifetime state.
async function loadFramework() {
  vi.resetModules();
  const [{ Suspense, lazy }, hydration, defer] = await Promise.all([
    import("../src/suspense.ts"),
    import("../src/hydration.ts"),
    import("../src/defer.ts"),
  ]);
  return { Suspense, lazy, ...hydration, ...defer };
}

// Early hydration is Preact 11 only (runtime-page.ts places the entry at the
// end on Preact 10); the Preact 10 CI job runs this file too.
const PREACT_11 = Object.keys(new (Component as unknown as new () => object)()).length > 2;

let readyState: DocumentReadyState;
let scratch: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** What the renderer's boundary-swap script does once the boundary arrives. */
function swapBoundary(id: string, html: string): Element {
  const start = [...scratch.childNodes].find((node) => node.nodeValue === `$s:${id}`)!;
  const end = [...scratch.childNodes].find((node) => node.nodeValue === `/$s:${id}`)!;
  while (start.nextSibling !== end) start.nextSibling!.remove();
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content.firstElementChild!;
  if (content) end.before(content);
  return content;
}

function finishDocument(): void {
  readyState = "interactive";
  document.dispatchEvent(new Event("DOMContentLoaded"));
}

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return h("button", { id: "boundary", onClick: () => setCount(count + 1) }, `${label} ${count}`);
}

describe("hydrating a streamed document before it finishes", () => {
  beforeEach(() => {
    readyState = "loading";
    Object.defineProperty(document, "readyState", { configurable: true, get: () => readyState });
    scratch = document.createElement("div");
    document.body.appendChild(scratch);
    delete (window as { __PRACHT_DEFER__?: unknown }).__PRACHT_DEFER__;
  });

  afterEach(() => {
    render(null, scratch);
    scratch.remove();
    delete (document as { readyState?: unknown }).readyState;
  });

  it.runIf(PREACT_11)(
    "resumes a deferred boundary against the swapped markup, not the fallback",
    async () => {
      const { Suspense, markHydrating, rehydrateDeferredData, use } = await loadFramework();
      scratch.innerHTML = '<h1>Shell</h1><!--$s:1--><p id="fallback">Loading</p><!--/$s:1-->';
      const data = rehydrateDeferredData({ value: null as unknown }, [
        { id: "0:value", path: ["value"] },
      ]);

      function Content() {
        return h(Counter, { label: use(data.value as Promise<string>) });
      }
      markHydrating();
      hydrate(
        h(Fragment, null, [
          h("h1", null, "Shell"),
          h(Suspense, { fallback: h("p", { id: "fallback" }, "Loading") }, h(Content, null)),
        ]),
        scratch,
      );

      // The value lands before the renderer has swapped the boundary in.
      (
        window as unknown as { __PRACHT_DEFER__: { r(id: string, v: unknown): void } }
      ).__PRACHT_DEFER__.r("0:value", "Ready");
      await settle();
      expect(scratch.querySelector("#fallback")).not.toBeNull();

      const swapped = swapBoundary("1", '<button id="boundary">Ready 0</button>');
      finishDocument();
      await settle();

      expect(scratch.querySelector("#fallback")).toBeNull();
      expect(scratch.querySelectorAll("#boundary")).toHaveLength(1);
      // Hydrated in place: the server node is kept and gains its handler.
      expect(scratch.querySelector("#boundary")).toBe(swapped);
      (swapped as HTMLButtonElement).click();
      await settle();
      expect(swapped.textContent).toBe("Ready 1");
    },
  );

  it.runIf(PREACT_11)(
    "resumes two boundaries reading one deferred value, one rendering nothing",
    async () => {
      const { Suspense, markHydrating, rehydrateDeferredData, use, useIsHydrated } =
        await loadFramework();
      scratch.innerHTML =
        "<!--$s:1--><p>Loading empty</p><!--/$s:1--><!--$s:2--><p>Loading</p><!--/$s:2-->";
      const data = rehydrateDeferredData({ value: null as unknown }, [
        { id: "0:value", path: ["value"] },
      ]);
      function Empty() {
        use(data.value as Promise<string>);
        return null;
      }
      function Content() {
        const label = use(data.value as Promise<string>);
        const hydrated = useIsHydrated();
        return h("button", { id: "boundary", disabled: !hydrated }, label);
      }
      markHydrating();
      hydrate(
        h(Fragment, null, [
          h(Suspense, { fallback: h("p", null, "Loading empty") }, h(Empty, null)),
          h(Suspense, { fallback: h("p", null, "Loading") }, h(Content, null)),
        ]),
        scratch,
      );

      (
        window as unknown as { __PRACHT_DEFER__: { r(id: string, v: unknown): void } }
      ).__PRACHT_DEFER__.r("0:value", "Ready");
      swapBoundary("1", "");
      const swapped = swapBoundary("2", '<button id="boundary" disabled>Ready</button>');
      finishDocument();
      await settle();

      expect(scratch.querySelector("#boundary")).toBe(swapped);
      expect((swapped as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it("delivers a deferred rejection only once the document is complete", async () => {
    const { rehydrateDeferredData, use } = await loadFramework();
    const data = rehydrateDeferredData({ value: null as unknown }, [
      { id: "0:value", path: ["value"] },
    ]);
    const read = () => {
      try {
        return use(data.value as Promise<unknown>);
      } catch (thrown) {
        return thrown;
      }
    };

    (
      window as unknown as { __PRACHT_DEFER__: { e(id: string, v: unknown): void } }
    ).__PRACHT_DEFER__.e("0:value", { message: "boom", name: "Error", status: 500 });
    await settle();
    expect(read()).toBeInstanceOf(Promise);

    finishDocument();
    await settle();
    expect(read()).toMatchObject({ message: "boom" });
  });

  it.runIf(PREACT_11)("resumes a lazy boundary against the swapped markup", async () => {
    const { Suspense, lazy, markHydrating } = await loadFramework();
    scratch.innerHTML = '<!--$s:2--><p id="fallback">Loading</p><!--/$s:2-->';
    let loadModule!: () => void;
    const Lazy = lazy(
      () =>
        new Promise<{ default: () => VNode<any> }>((resolve) => {
          loadModule = () => resolve({ default: () => h(Counter, { label: "Lazy" }) });
        }),
    );

    markHydrating();
    hydrate(
      h(Suspense, { fallback: h("p", { id: "fallback" }, "Loading") }, h(Lazy, null)),
      scratch,
    );

    // The chunk loads before the renderer has swapped the boundary in.
    loadModule();
    await settle();
    expect(scratch.querySelector("#fallback")).not.toBeNull();

    const swapped = swapBoundary("2", '<button id="boundary">Lazy 0</button>');
    finishDocument();
    await settle();

    expect(scratch.querySelector("#boundary")).toBe(swapped);
    (swapped as HTMLButtonElement).click();
    await settle();
    expect(swapped.textContent).toBe("Lazy 1");
  });

  it("keeps the synchronous path once the document is complete", async () => {
    readyState = "complete";
    const { rehydrateDeferredData, use } = await loadFramework();
    const data = rehydrateDeferredData({ value: null as unknown }, [
      { id: "0:value", path: ["value"] },
    ]);
    (
      window as unknown as { __PRACHT_DEFER__: { r(id: string, v: unknown): void } }
    ).__PRACHT_DEFER__.r("0:value", "Ready");
    expect(use(data.value as Promise<string>)).toBe("Ready");
  });
});
