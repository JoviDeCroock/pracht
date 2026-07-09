import { describe, expect, it, vi } from "vitest";

import {
  createScrollPositionStore,
  generateScrollKey,
  HISTORY_STATE_KEY,
  readScrollKeyFromHistoryState,
  withScrollKeyInHistoryState,
  type ScrollStorage,
} from "../src/scroll-restoration.ts";

function createMemoryStorage(initial: Record<string, string> = {}): ScrollStorage & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("createScrollPositionStore", () => {
  it("stores and returns scroll positions", () => {
    const store = createScrollPositionStore(createMemoryStorage());
    store.set("a", { x: 0, y: 120 });

    expect(store.get("a")).toEqual({ x: 0, y: 120 });
    expect(store.get("missing")).toBeNull();
  });

  it("persists positions to storage and reads them back in a new store", () => {
    const storage = createMemoryStorage();
    const store = createScrollPositionStore(storage);
    store.set("entry", { x: 10, y: 500 });

    // A fresh store over the same storage (e.g. after a reload) sees the value.
    const revived = createScrollPositionStore(storage);
    expect(revived.get("entry")).toEqual({ x: 10, y: 500 });
  });

  it("bounds the number of stored entries, evicting the least recently set", () => {
    const store = createScrollPositionStore(createMemoryStorage(), 3);
    store.set("a", { x: 0, y: 1 });
    store.set("b", { x: 0, y: 2 });
    store.set("c", { x: 0, y: 3 });
    // Touch "a" so it becomes most recent, then overflow.
    store.set("a", { x: 0, y: 11 });
    store.set("d", { x: 0, y: 4 });

    expect(store.get("b")).toBeNull();
    expect(store.get("a")).toEqual({ x: 0, y: 11 });
    expect(store.get("c")).toEqual({ x: 0, y: 3 });
    expect(store.get("d")).toEqual({ x: 0, y: 4 });
  });

  it("tolerates corrupted storage payloads", () => {
    const storage = createMemoryStorage({ "pracht:scroll-positions": "not-json{" });
    const store = createScrollPositionStore(storage);
    expect(store.get("anything")).toBeNull();

    store.set("a", { x: 0, y: 42 });
    expect(store.get("a")).toEqual({ x: 0, y: 42 });
  });

  it("ignores malformed entries inside a valid payload", () => {
    const storage = createMemoryStorage({
      "pracht:scroll-positions": JSON.stringify([["good", 1, 2], ["bad"], "nope", 5]),
    });
    const store = createScrollPositionStore(storage);
    expect(store.get("good")).toEqual({ x: 1, y: 2 });
    expect(store.get("bad")).toBeNull();
  });

  it("keeps working in memory when storage writes throw", () => {
    const storage: ScrollStorage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError");
      }),
    };
    const store = createScrollPositionStore(storage);

    expect(() => store.set("a", { x: 0, y: 9 })).not.toThrow();
    expect(store.get("a")).toEqual({ x: 0, y: 9 });
  });

  it("works without any storage backend", () => {
    const store = createScrollPositionStore(null);
    store.set("a", { x: 3, y: 4 });
    expect(store.get("a")).toEqual({ x: 3, y: 4 });
  });
});

describe("history state scroll keys", () => {
  it("generates non-empty keys", () => {
    const key = generateScrollKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("reads keys only from object states carrying the marker", () => {
    expect(readScrollKeyFromHistoryState(null)).toBeNull();
    expect(readScrollKeyFromHistoryState("string-state")).toBeNull();
    expect(readScrollKeyFromHistoryState({})).toBeNull();
    expect(readScrollKeyFromHistoryState({ [HISTORY_STATE_KEY]: 42 })).toBeNull();
    expect(readScrollKeyFromHistoryState({ [HISTORY_STATE_KEY]: "abc" })).toBe("abc");
  });

  it("merges the key into existing object states without dropping user state", () => {
    const merged = withScrollKeyInHistoryState({ custom: 1 }, "k1");
    expect(merged).toEqual({ custom: 1, [HISTORY_STATE_KEY]: "k1" });
  });

  it("replaces non-object states with a fresh key-only object", () => {
    expect(withScrollKeyInHistoryState(null, "k1")).toEqual({ [HISTORY_STATE_KEY]: "k1" });
    expect(withScrollKeyInHistoryState("legacy", "k1")).toEqual({ [HISTORY_STATE_KEY]: "k1" });
    expect(withScrollKeyInHistoryState([1, 2], "k1")).toEqual({ [HISTORY_STATE_KEY]: "k1" });
  });
});
