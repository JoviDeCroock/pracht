import { describe, expect, it, vi } from "vitest";

import { defer, isDeferred, resolveDeferredData, use } from "../src/defer.ts";

function deferredLater<T>(value: T, ms = 0): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("defer()", () => {
  it("marks a promise without awaiting it", () => {
    let settled = false;
    const promise = Promise.resolve("reviews").then((value) => {
      settled = true;
      return value;
    });
    const marked = defer(promise);
    expect(isDeferred(marked)).toBe(true);
    expect(settled).toBe(false);
  });

  it("does not start a thunk until the value is read", async () => {
    const work = vi.fn(async () => "reviews");
    const marked = defer(work);
    expect(work).not.toHaveBeenCalled();

    await resolveDeferredData({ reviews: marked });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("starts a thunk exactly once across repeated reads", async () => {
    const work = vi.fn(async () => "reviews");
    const marked = defer(work);

    await resolveDeferredData({ a: marked, b: marked });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-awaited value with an actionable message", () => {
    // The mistake this catches is `defer(await getReviews())`, which defeats
    // the point silently.
    expect(() => defer("reviews" as never)).toThrow(/Pass the un-awaited call/);
  });

  it("surfaces a synchronous throw from a thunk as a rejection", async () => {
    const marked = defer(() => {
      throw new Error("boom");
    });
    await expect(resolveDeferredData({ reviews: marked })).rejects.toThrow("boom");
  });
});

describe("resolveDeferredData()", () => {
  it("returns the input by reference when nothing defers", async () => {
    const data = { product: { id: 1 }, tags: ["a", "b"] };
    expect(await resolveDeferredData(data)).toBe(data);
  });

  it("replaces deferred fields with their settled values", async () => {
    const data = {
      product: { id: 1 },
      reviews: defer(deferredLater([{ id: 7 }])),
    };
    expect(await resolveDeferredData(data)).toEqual({
      product: { id: 1 },
      reviews: [{ id: 7 }],
    });
  });

  it("resolves nested and array-held deferred values", async () => {
    const data = {
      sections: [{ items: defer(deferredLater(["a"])) }],
      meta: { nested: { deep: defer(deferredLater(42)) } },
    };
    expect(await resolveDeferredData(data)).toEqual({
      sections: [{ items: ["a"] }],
      meta: { nested: { deep: 42 } },
    });
  });

  it("resolves independent fields concurrently, not in series", async () => {
    const data = {
      a: defer(deferredLater("a", 40)),
      b: defer(deferredLater("b", 40)),
      c: defer(deferredLater("c", 40)),
    };
    const start = Date.now();
    await resolveDeferredData(data);
    // Three 40ms fields in series would be ~120ms. Generous ceiling so this
    // does not flake under parallel CI load; it still fails a serial resolve.
    expect(Date.now() - start).toBeLessThan(110);
  });

  it("propagates a rejection so the loader boundary sees it", async () => {
    const data = { reviews: defer(Promise.reject(new Error("upstream 500"))) };
    await expect(resolveDeferredData(data)).rejects.toThrow("upstream 500");
  });

  it("leaves non-plain objects by reference", async () => {
    const when = new Date(0);
    const data = { when, reviews: defer(deferredLater([])) };
    const resolved = await resolveDeferredData(data);
    expect(resolved.when).toBe(when);
  });

  it("handles a null prototype object", async () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.reviews = defer(deferredLater("ok"));
    expect(await resolveDeferredData({ bare })).toEqual({ bare: { reviews: "ok" } });
  });

  it("does not recurse forever on a cyclic value", async () => {
    const cyclic: Record<string, unknown> = { reviews: defer(deferredLater("ok")) };
    cyclic.self = cyclic;
    await expect(resolveDeferredData(cyclic)).resolves.toBeDefined();
  });

  it("passes primitives and null through untouched", async () => {
    expect(await resolveDeferredData(null)).toBe(null);
    expect(await resolveDeferredData(undefined)).toBe(undefined);
    expect(await resolveDeferredData("plain")).toBe("plain");
  });
});

describe("use()", () => {
  it("returns an already-settled value directly", () => {
    // This is the case on every path today, and always for ssg/isg — it is
    // what lets one component work whether or not the route streams.
    expect(use("reviews")).toBe("reviews");
    expect(use(null)).toBe(null);
  });

  it("throws the pending promise so a Suspense boundary can catch it", () => {
    const marked = defer(deferredLater("reviews", 10));
    let thrown: unknown;
    try {
      use(marked);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Promise);
  });

  it("returns the value once the thrown promise has settled", async () => {
    const marked = defer(deferredLater("reviews", 5));
    try {
      use(marked);
    } catch (promise) {
      await promise;
    }
    expect(use(marked)).toBe("reviews");
  });

  it("rethrows a rejection once settled so the nearest ErrorBoundary renders", async () => {
    const marked = defer(Promise.reject(new Error("upstream 500")));
    try {
      use(marked);
    } catch (promise) {
      await (promise as Promise<unknown>).catch(() => {});
    }
    expect(() => use(marked)).toThrow("upstream 500");
  });

  it("accepts a bare promise", async () => {
    const promise = deferredLater("reviews", 5);
    try {
      use(promise);
    } catch (thrown) {
      await thrown;
    }
    expect(use(promise)).toBe("reviews");
  });
});
