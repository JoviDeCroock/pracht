import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetDeferredTrackingForTesting,
  defer,
  isDeferred,
  resolveDeferredData,
} from "../src/defer.ts";

/**
 * A loader payload that records every property access made against it.
 *
 * `resolveDeferredData()` runs on every loader result, so "did anything touch
 * this object?" is the only honest way to ask whether the deep walk ran.
 */
function trackedPayload(): { accesses: string[]; payload: Record<string, unknown> } {
  const accesses: string[] = [];
  const target = { product: { id: 1 }, tags: ["a", "b"] };
  const payload = new Proxy(target, {
    get(t, key, receiver) {
      accesses.push(`get:${String(key)}`);
      return Reflect.get(t, key, receiver);
    },
    getOwnPropertyDescriptor(t, key) {
      accesses.push(`descriptor:${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    ownKeys(t) {
      accesses.push("ownKeys");
      return Reflect.ownKeys(t);
    },
    getPrototypeOf(t) {
      accesses.push("prototype");
      return Reflect.getPrototypeOf(t);
    },
  });
  return { accesses, payload };
}

describe("resolveDeferredData() cost", () => {
  beforeEach(() => {
    _resetDeferredTrackingForTesting();
  });

  it("does not walk the payload when the app never called defer()", async () => {
    const { accesses, payload } = trackedPayload();

    expect(await resolveDeferredData(payload)).toBe(payload);
    // `get:then` is the `await` on the returned value probing for a thenable,
    // not the walk.
    expect(accesses.filter((access) => access !== "get:then")).toEqual([]);
  });

  it("walks the payload once defer() has been used", async () => {
    const marker = defer(Promise.resolve("reviews"));
    expect(isDeferred(marker)).toBe(true);

    const { accesses, payload } = trackedPayload();
    expect(await resolveDeferredData(payload)).toBe(payload);
    expect(accesses).toContain("ownKeys");
  });

  it("still resolves deferred values found by the walk", async () => {
    const data = { product: { id: 1 }, reviews: defer(Promise.resolve([{ id: 7 }])) };

    expect(await resolveDeferredData(data)).toEqual({
      product: { id: 1 },
      reviews: [{ id: 7 }],
    });
  });
});
