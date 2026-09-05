import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  defer,
  isDeferred,
  rehydrateDeferredData,
  resolveDeferredData,
  serializeDeferred,
  type Deferred,
  use,
} from "../src/defer.ts";
import type { HeadArgs, HeadersArgs, RouteComponentProps } from "../src/types.ts";
import { PrachtHttpError } from "../src/types.ts";

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

  it("observes an eager rejection until the marker is read", async () => {
    const error = new Error("upstream 500");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const marked = defer(Promise.reject(error));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      await expect(resolveDeferredData({ reviews: marked })).rejects.toBe(error);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

  it("keeps the marker covariant for reusable component props", () => {
    interface Animal {
      name: string;
    }
    interface Dog extends Animal {
      bark(): void;
    }

    const dog = defer(Promise.resolve<Dog>({ name: "Rex", bark() {} }));
    const animal: Deferred<Animal> = dog;
    expect(animal).toBe(dog);
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

  it("continues resolving deferred values inside a deferred result", async () => {
    const data = {
      section: defer(
        deferredLater({
          items: [defer(deferredLater("a"))],
        }),
      ),
    };
    expect(await resolveDeferredData(data)).toEqual({
      section: { items: ["a"] },
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

  it("rejects a Response returned from deferred work", async () => {
    const data = { result: defer(Promise.resolve(new Response(null, { status: 202 }))) };
    await expect(resolveDeferredData(data)).rejects.toThrow(
      "A deferred loader value cannot return or throw a Response",
    );
  });

  it("rejects a PrachtHttpError thrown from deferred work", async () => {
    const data = {
      result: defer(Promise.reject(new PrachtHttpError(404, "late missing"))),
    };
    await expect(resolveDeferredData(data)).rejects.toThrow(
      "A deferred loader value cannot return or throw a Response or throw a PrachtHttpError",
    );
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
    const resolved = await resolveDeferredData({ bare });
    expect(resolved).toEqual({ bare: { reviews: "ok" } });
    expect(Object.getPrototypeOf(resolved.bare)).toBeNull();
  });

  it("preserves an own __proto__ data property", async () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"reviews":null}') as Record<
      string,
      unknown
    >;
    data.reviews = defer(deferredLater("ok"));

    const resolved = await resolveDeferredData(data);

    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(Object.hasOwn(resolved, "__proto__")).toBe(true);
    expect(resolved.__proto__).toEqual({ polluted: true });
    expect("polluted" in resolved).toBe(false);
    expect(JSON.stringify(resolved)).toBe('{"__proto__":{"polluted":true},"reviews":"ok"}');
  });

  it("does not evaluate unrelated getters while resolving deferred fields", async () => {
    let reads = 0;
    const data = {
      get sequence() {
        reads += 1;
        return reads;
      },
      reviews: defer(deferredLater("ok")),
    };

    const resolved = await resolveDeferredData(data);

    expect(reads).toBe(0);
    expect(JSON.stringify(resolved)).toBe('{"sequence":1,"reviews":"ok"}');
    expect(reads).toBe(1);
  });

  it("does not evaluate array index getters while looking for deferred fields", async () => {
    let reads = 0;
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads;
      },
    });
    values.length = 1;
    const data = { values };

    const resolved = await resolveDeferredData(data);

    expect(resolved).toBe(data);
    expect(reads).toBe(0);
    expect(JSON.stringify(resolved)).toBe('{"values":[1]}');
    expect(reads).toBe(1);
  });

  it("preserves array index getters while resolving sibling deferred values", async () => {
    let reads = 0;
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads;
      },
    });
    values[1] = defer(deferredLater("ok"));

    const resolved = await resolveDeferredData({ values });

    expect(reads).toBe(0);
    expect(JSON.stringify(resolved)).toBe('{"values":[1,"ok"]}');
    expect(reads).toBe(1);
  });

  it("rejects a deferred marker returned from an array getter", async () => {
    const value = defer(deferredLater("ok"));
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      configurable: true,
      enumerable: true,
      get() {
        return value;
      },
    });
    values.length = 1;

    const resolved = await resolveDeferredData({ values });

    expect(() => JSON.stringify(resolved)).toThrow(
      "Return defer() from an enumerable data property, not from a getter",
    );
  });

  it("preserves non-enumerable state read by an enumerable getter", async () => {
    const data = {
      get publicId() {
        return (this as { internalId?: number }).internalId;
      },
      reviews: defer(deferredLater("ok")),
    };
    Object.defineProperty(data, "internalId", { value: 42 });

    const resolved = await resolveDeferredData(data);

    expect(JSON.stringify(resolved)).toBe('{"publicId":42,"reviews":"ok"}');
  });

  it("rejects a deferred marker returned from a getter instead of serializing it as an object", async () => {
    const reviews = defer(deferredLater("ok"));
    const data = {
      get reviews() {
        return reviews;
      },
    };

    const resolved = await resolveDeferredData(data);

    expect(() => JSON.stringify(resolved)).toThrow(
      "Return defer() from an enumerable data property, not from a getter",
    );
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

describe("deferred loader data types", () => {
  async function loader() {
    return {
      product: { name: "Widget" },
      reviews: defer(Promise.resolve([{ id: 1 }])),
      summary: { score: defer(Promise.resolve(5)) },
    };
  }

  it("preserves deferred markers for head, headers, and components", () => {
    expectTypeOf<HeadArgs<typeof loader>["data"]>().toEqualTypeOf<
      Awaited<ReturnType<typeof loader>>
    >();
    expectTypeOf<HeadersArgs<typeof loader>["data"]>().toEqualTypeOf<
      Awaited<ReturnType<typeof loader>>
    >();
    expectTypeOf<RouteComponentProps<typeof loader>["data"]["reviews"]>().toEqualTypeOf<
      Deferred<{ id: number }[]>
    >();
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

  it("distributes its result type across optional deferred values", () => {
    const optional = null as Deferred<string> | null;
    const result: string | null = use(optional);
    expect(result).toBeNull();
  });
});

describe("streaming wire metadata", () => {
  async function settle(value: unknown): Promise<unknown> {
    try {
      return use(value);
    } catch (promise) {
      await promise;
      return use(value);
    }
  }

  it("keeps dotted keys distinct from nested paths", async () => {
    const { data, pending } = serializeDeferred({
      "a.b": defer(Promise.resolve("flat")),
      a: { b: defer(Promise.resolve("nested")) },
    });
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window = globals.window ?? {};
    try {
      const hydrated = rehydrateDeferredData(
        data,
        pending.map(({ id, path }) => ({ id, path })),
      ) as { "a.b": unknown; a: { b: unknown } };
      const registry = (
        globals.window as {
          __PRACHT_DEFER__: { r(id: string, value: unknown): void };
        }
      ).__PRACHT_DEFER__;
      for (const entry of pending) registry.r(entry.id, await entry.promise);

      await expect(settle(hydrated["a.b"])).resolves.toBe("flat");
      await expect(settle(hydrated.a.b)).resolves.toBe("nested");
    } finally {
      if (!hadWindow) delete globals.window;
    }
  });

  it("does not interpret user objects as deferred metadata", () => {
    const userValue = { "$pracht:defer": "ordinary-data" };
    expect(rehydrateDeferredData(userValue)).toBe(userValue);
  });

  it("does not invoke accessors while discovering deferred values", () => {
    let reads = 0;
    const source = {
      get reviews() {
        reads += 1;
        return defer(Promise.resolve(`reviews-${reads}`));
      },
    };

    const { data, pending } = serializeDeferred(source);

    expect(reads).toBe(0);
    expect(pending).toEqual([]);
    expect(() => JSON.stringify(data)).toThrow(
      "Return defer() from an enumerable data property, not from a getter",
    );
    expect(reads).toBe(1);
  });

  it("does not invoke array accessors while discovering deferred values", () => {
    let reads = 0;
    const source: unknown[] = [];
    Object.defineProperty(source, "0", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return defer(Promise.resolve(`reviews-${reads}`));
      },
    });
    source.length = 1;

    const { data, pending } = serializeDeferred(source);

    expect(reads).toBe(0);
    expect(pending).toEqual([]);
    expect(() => JSON.stringify(data)).toThrow(
      "Return defer() from an enumerable data property, not from a getter",
    );
    expect(reads).toBe(1);
  });

  it("preserves serialized error metadata on deferred rejections", async () => {
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window = globals.window ?? {};
    try {
      const hydrated = rehydrateDeferredData({ value: null }, [
        { id: "deferred-error", path: ["value"] },
      ]) as { value: unknown };
      const registry = (
        globals.window as {
          __PRACHT_DEFER__: { e(id: string, error: unknown): void };
        }
      ).__PRACHT_DEFER__;
      registry.e("deferred-error", {
        message: "Not found",
        name: "PrachtHttpError",
        status: 404,
      });

      await expect(settle(hydrated.value)).rejects.toMatchObject({
        message: "Not found",
        name: "PrachtHttpError",
        status: 404,
      });
    } finally {
      if (!hadWindow) delete globals.window;
    }
  });

  it("serializes every occurrence of a shared object", () => {
    const shared = { value: defer(Promise.resolve("ok")) };
    const { data, pending } = serializeDeferred({ first: shared, second: shared });

    expect(data).toEqual({ first: { value: null }, second: { value: null } });
    expect(pending.map(({ path }) => path)).toEqual([
      ["first", "value"],
      ["second", "value"],
    ]);
  });

  it("preserves __proto__ data without polluting Object.prototype", async () => {
    const source = JSON.parse('{"__proto__":{}}') as Record<string, any>;
    source.__proto__.polluted = defer(Promise.resolve("safe"));
    const { data, pending } = serializeDeferred(source);
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window = globals.window ?? {};

    try {
      expect(Object.hasOwn(data as object, "__proto__")).toBe(true);
      const hydrated = rehydrateDeferredData(
        JSON.parse(JSON.stringify(data)),
        pending.map(({ id, path }) => ({ id, path })),
      ) as Record<string, any>;
      const registry = (
        globals.window as {
          __PRACHT_DEFER__: { r(id: string, value: unknown): void };
        }
      ).__PRACHT_DEFER__;
      registry.r(pending[0].id, await pending[0].promise);

      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
      expect(Object.hasOwn(hydrated, "__proto__")).toBe(true);
      await expect(settle(hydrated.__proto__.polluted)).resolves.toBe("safe");
    } finally {
      delete (Object.prototype as { polluted?: unknown }).polluted;
      if (!hadWindow) delete globals.window;
    }
  });

  it("rejects deferred paths that would traverse inherited properties", () => {
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window = globals.window ?? {};
    try {
      expect(() =>
        rehydrateDeferredData({}, [{ id: "forged", path: ["__proto__", "polluted"] }]),
      ).toThrow(/Invalid deferred hydration path/);
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    } finally {
      delete (Object.prototype as { polluted?: unknown }).polluted;
      if (!hadWindow) delete globals.window;
    }
  });
});

it("reads queued hydration data synchronously and preserves its first settlement", () => {
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    __PRACHT_DEFER__: {
      q: [
        ["already-settled", "ready", 0],
        ["already-settled", "ignored", 0],
      ],
    },
  };
  try {
    const data = rehydrateDeferredData({ value: null }, [
      { id: "already-settled", path: ["value"] },
    ]);
    expect(use(data.value)).toBe("ready");
  } finally {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
});
