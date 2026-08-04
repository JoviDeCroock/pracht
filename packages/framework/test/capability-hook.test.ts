// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityEnvelope } from "../../capabilities/src/index.ts";
import { createUseCapability } from "../src/capability-hook.ts";

type Deferred = {
  resolve: (envelope: CapabilityEnvelope<{ notes: string[] }>) => void;
  reject: (error: unknown) => void;
  promise: Promise<CapabilityEnvelope<{ notes: string[] }>>;
};

function defer(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<CapabilityEnvelope<{ notes: string[] }>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/** Flush microtasks so state updates from resolved promises are applied. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useCapability", () => {
  let root: HTMLDivElement;
  let calls: Array<{ name: string; args: unknown[] }>;
  let pending: Deferred[];

  // Hook state is only observable through a rendered component, so each test
  // renders one and reads the latest value captured during render.
  let latest: ReturnType<ReturnType<typeof createUseCapability>> | undefined;
  let renderCount: number;
  let probe: (name: string) => void;

  const dispatch = (name: string, ...args: unknown[]) => {
    calls.push({ args, name });
    const deferred = defer();
    pending.push(deferred);
    return deferred.promise as Promise<CapabilityEnvelope<unknown>>;
  };

  function renderHook(name = "notes.search"): void {
    const useCapability = createUseCapability(dispatch);
    function Probe({ capability }: { capability: string }) {
      renderCount += 1;
      latest = useCapability<{ notes: string[] }>(capability);
      return null;
    }
    // Keep the component type stable across re-renders so switching `capability`
    // updates the same hook instance rather than mounting a fresh one.
    probe = (next: string) => render(h(Probe, { capability: next }), root);
    probe(name);
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    calls = [];
    pending = [];
    latest = undefined;
    renderCount = 0;
  });

  afterEach(() => {
    render(null, root);
    root.remove();
  });

  it("starts idle and forwards call arguments to the dispatcher", async () => {
    renderHook();

    expect(latest).toMatchObject({ data: undefined, error: undefined, pending: false });

    void latest!.call({ query: "roadmap" }, { revalidate: false });
    await tick();

    expect(calls).toEqual([
      { args: [{ query: "roadmap" }, { revalidate: false }], name: "notes.search" },
    ]);
    expect(latest!.pending).toBe(true);
  });

  it("exposes data from a successful envelope and returns it to the caller", async () => {
    renderHook();

    const result = latest!.call({ query: "roadmap" });
    pending[0].resolve({ data: { notes: ["a"] }, ok: true });
    await expect(result).resolves.toEqual({ data: { notes: ["a"] }, ok: true });
    await tick();

    expect(latest).toMatchObject({
      data: { notes: ["a"] },
      error: undefined,
      pending: false,
    });
  });

  it("settles a failed envelope as error state rather than throwing", async () => {
    renderHook();

    const result = latest!.call({ query: "" });
    pending[0].resolve({
      error: { code: "invalid_input", message: "bad" },
      ok: false,
    });
    await expect(result).resolves.toMatchObject({ ok: false });
    await tick();

    expect(latest).toMatchObject({
      data: undefined,
      error: { code: "invalid_input", message: "bad" },
      pending: false,
    });
  });

  it("keeps previous data visible and clears the stale error while refetching", async () => {
    renderHook();

    void latest!.call({ query: "a" });
    pending[0].resolve({ data: { notes: ["first"] }, ok: true });
    await tick();
    expect(latest!.data).toEqual({ notes: ["first"] });

    void latest!.call({ query: "b" });
    await tick();

    // Data persists so the UI does not flash empty during a refetch.
    expect(latest).toMatchObject({ data: { notes: ["first"] }, error: undefined, pending: true });

    pending[1].resolve({
      error: { code: "invalid_input", message: "bad retry" },
      ok: false,
    });
    await tick();

    // `data` is the most recent successful result until reset; a failed retry
    // adds its error without erasing content the UI was already rendering.
    expect(latest).toMatchObject({
      data: { notes: ["first"] },
      error: { code: "invalid_input", message: "bad retry" },
      pending: false,
    });
  });

  it("discards a slow earlier response when a newer call has been made", async () => {
    renderHook();

    void latest!.call({ query: "slow" });
    void latest!.call({ query: "fast" });
    await tick();

    // The second call resolves first, then the first call's stale response
    // arrives — typing into a search box does exactly this.
    pending[1].resolve({ data: { notes: ["fast"] }, ok: true });
    await tick();
    pending[0].resolve({ data: { notes: ["slow"] }, ok: true });
    await tick();

    expect(latest!.data).toEqual({ notes: ["fast"] });
    expect(latest!.pending).toBe(false);
  });

  it("reset() clears state and abandons an in-flight call", async () => {
    renderHook();

    void latest!.call({ query: "a" });
    pending[0].resolve({ data: { notes: ["first"] }, ok: true });
    await tick();

    void latest!.call({ query: "b" });
    await tick();
    latest!.reset();
    await tick();

    expect(latest).toMatchObject({ data: undefined, error: undefined, pending: false });

    // The abandoned call resolving must not repopulate what reset() cleared.
    pending[1].resolve({ data: { notes: ["late"] }, ok: true });
    await tick();
    expect(latest!.data).toBeUndefined();
  });

  it("does not update state after unmount", async () => {
    // Asserting on a render-captured value would pass whether or not a write
    // happened. Count renders instead: a state write on an unmounted component
    // is only observable as the render it would have caused.
    renderHook();
    const rendersBeforeUnmount = renderCount;
    const call = latest!.call({ query: "a" });
    await tick();

    render(null, root);
    const rendersAtUnmount = renderCount;
    pending[0].resolve({ data: { notes: ["late"] }, ok: true });
    await call;
    await tick();

    expect(renderCount).toBe(rendersAtUnmount);
    expect(rendersAtUnmount).toBeGreaterThan(rendersBeforeUnmount);
  });

  it("drops the previous capability's state when the name changes", async () => {
    // `data` is typed as the *current* capability's output, so carrying the
    // previous one's result across a switch is unsound as well as a UI bug.
    renderHook("notes.search");
    void latest!.call({ query: "a" });
    pending[0].resolve({ data: { notes: ["from-search"] }, ok: true });
    await tick();
    expect(latest!.data).toEqual({ notes: ["from-search"] });

    probe("notes.archive");
    await tick();

    expect(latest).toMatchObject({ data: undefined, error: undefined, pending: false });
  });

  it("ignores a call still in flight when the name changes under it", async () => {
    renderHook("notes.search");
    void latest!.call({ query: "a" });
    await tick();

    probe("notes.archive");
    await tick();

    // The old capability's response must not populate the new one's state.
    pending[0].resolve({ data: { notes: ["from-search"] }, ok: true });
    await tick();

    expect(latest!.data).toBeUndefined();
  });

  it("does not resurrect state or an in-flight result after switching away and back", async () => {
    renderHook("notes.search");
    void latest!.call({ query: "a" });
    await tick();

    probe("notes.archive");
    await tick();
    probe("notes.search");
    await tick();

    // Returning to the original name is a new generation, not a cache lookup.
    // The first generation's eventual response must stay abandoned.
    pending[0].resolve({ data: { notes: ["stale-search"] }, ok: true });
    await tick();

    expect(latest).toMatchObject({ data: undefined, error: undefined, pending: false });
  });

  it("clears pending and rethrows when the dispatcher itself throws", async () => {
    renderHook();

    const call = latest!.call({ query: "a" });
    pending[0].reject(new TypeError("boom"));

    await expect(call).rejects.toThrow("boom");
    await tick();

    // A stuck spinner is worse than a surfaced bug: pending must not latch.
    expect(latest!.pending).toBe(false);
  });
});
