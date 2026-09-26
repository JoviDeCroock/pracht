import { describe, expect, it } from "vitest";

import { defer } from "../src/defer.ts";
import {
  decodeRouteData,
  encodeRouteData,
  mayContainEncodedRouteData,
} from "../src/route-data-codec.ts";
import { escapeScriptText, serializeJsonForHtml } from "../src/runtime-html.ts";

/** Encode, send through JSON text, and decode — the path every transport takes. */
function roundTrip<T>(value: T): T {
  const text = JSON.stringify(encodeRouteData(value));
  const parsed = JSON.parse(text) as unknown;
  return (mayContainEncodedRouteData(text) ? decodeRouteData(parsed) : parsed) as T;
}

describe("encodeRouteData() / decodeRouteData()", () => {
  it("leaves JSON-only data byte-identical to JSON.stringify", () => {
    const value = {
      title: "Hello",
      count: 3,
      ratio: 0.5,
      published: true,
      author: null,
      tags: ["a", "b", { nested: [1, 2, 3] }],
      empty: {},
      "weird key": "x",
      "0": "numeric key",
    };
    const encoded = JSON.stringify(encodeRouteData(value));
    expect(encoded).toBe(JSON.stringify(value));
    expect(mayContainEncodedRouteData(encoded)).toBe(false);
    expect(roundTrip(value)).toEqual(value);
  });

  it("round-trips primitives JSON cannot represent", () => {
    const value = {
      missing: undefined,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
      negZero: -0,
      big: 12345678901234567890n,
      negativeBig: -5n,
      list: [undefined, 1, undefined],
    };
    const result = roundTrip(value);
    expect(Object.hasOwn(result, "missing")).toBe(true);
    expect(result.missing).toBeUndefined();
    expect(result.nan).toBeNaN();
    expect(result.inf).toBe(Number.POSITIVE_INFINITY);
    expect(result.negInf).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(result.negZero, -0)).toBe(true);
    expect(result.big).toBe(12345678901234567890n);
    expect(result.negativeBig).toBe(-5n);
    expect(result.list).toEqual([undefined, 1, undefined]);
    expect(result.list).toHaveLength(3);
  });

  it("round-trips array holes as undefined", () => {
    // oxlint-disable-next-line no-sparse-arrays
    const result = roundTrip([1, , 3]);
    expect(result).toHaveLength(3);
    expect(1 in result).toBe(true);
    expect(result[1]).toBeUndefined();
  });

  it("leaves a top-level undefined absent from the envelope", () => {
    expect(encodeRouteData(undefined)).toBeUndefined();
    expect(JSON.stringify({ data: encodeRouteData(undefined) })).toBe("{}");
  });

  it("round-trips a top-level bigint or special number", () => {
    expect(roundTrip(7n)).toBe(7n);
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(roundTrip(null)).toBeNull();
    expect(roundTrip("text")).toBe("text");
  });

  it("round-trips Date, RegExp, and URL", () => {
    const createdAt = new Date("2026-01-02T03:04:05.678Z");
    const value = {
      createdAt,
      invalid: new Date(Number.NaN),
      pattern: /a+b?\/<\/script>/giu,
      link: new URL("https://example.com/a?b=1#c"),
    };
    const result = roundTrip(value);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.getTime()).toBe(createdAt.getTime());
    expect(result.invalid).toBeInstanceOf(Date);
    expect(Number.isNaN(result.invalid.getTime())).toBe(true);
    expect(result.pattern).toBeInstanceOf(RegExp);
    expect(result.pattern.source).toBe(value.pattern.source);
    expect(result.pattern.flags).toBe("giu");
    expect(result.link).toBeInstanceOf(URL);
    expect(result.link.href).toBe("https://example.com/a?b=1#c");
  });

  it("round-trips Map and Set with rich keys and values", () => {
    const key = { id: 1 };
    const value = {
      map: new Map<unknown, unknown>([
        ["a", new Date(0)],
        [2, new Set([1, "two", undefined])],
        [key, "object key"],
      ]),
      set: new Set([new Map([["nested", 1n]])]),
      emptyMap: new Map(),
      emptySet: new Set(),
    };
    const result = roundTrip(value);
    expect(result.map).toBeInstanceOf(Map);
    expect([...result.map.keys()].slice(0, 2)).toEqual(["a", 2]);
    expect(result.map.get("a")).toEqual(new Date(0));
    expect(result.map.get(2)).toEqual(new Set([1, "two", undefined]));
    const [, , [objectKey, objectValue]] = [...result.map.entries()];
    expect(objectKey).toEqual({ id: 1 });
    expect(objectValue).toBe("object key");
    expect(result.set).toBeInstanceOf(Set);
    expect([...result.set][0]).toEqual(new Map([["nested", 1n]]));
    expect(result.emptyMap).toEqual(new Map());
    expect(result.emptySet).toEqual(new Set());
  });

  it("preserves shared references", () => {
    const user = { name: "Ada" };
    const when = new Date(5);
    const value = { author: user, editor: user, list: [user, when, when] };
    const result = roundTrip(value);
    expect(result.author).toEqual({ name: "Ada" });
    expect(result.author).toBe(result.editor);
    expect(result.list[0]).toBe(result.author);
    expect(result.list[1]).toBe(result.list[2]);
    expect(result.list[1]).toBeInstanceOf(Date);
  });

  it("writes a shared object once", () => {
    const user = { name: "a".repeat(200) };
    const text = JSON.stringify(encodeRouteData({ a: user, b: user, c: user }));
    expect(text.split("a".repeat(200))).toHaveLength(2);
  });

  it("preserves cycles through objects, arrays, Maps, and Sets", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const list: unknown[] = [node];
    list.push(list);
    node.list = list;
    const map = new Map<string, unknown>();
    map.set("me", map);
    map.set("node", node);
    const set = new Set<unknown>();
    set.add(set);
    node.map = map;
    node.set = set;

    const result = roundTrip(node);
    expect(result.self).toBe(result);
    const resultList = result.list as unknown[];
    expect(resultList[0]).toBe(result);
    expect(resultList[1]).toBe(resultList);
    const resultMap = result.map as Map<string, unknown>;
    expect(resultMap.get("me")).toBe(resultMap);
    expect(resultMap.get("node")).toBe(result);
    const resultSet = result.set as Set<unknown>;
    expect(resultSet.has(resultSet)).toBe(true);
  });

  it("preserves a cycle at the root of a Map key", () => {
    const key: Record<string, unknown> = {};
    const map = new Map([[key, key]]);
    key.map = map;
    const result = roundTrip(map);
    const [[resultKey, resultValue]] = [...result.entries()];
    expect(resultKey).toBe(resultValue);
    expect((resultKey as { map: unknown }).map).toBe(result);
  });

  it("escapes user strings that look like tags", () => {
    const value = {
      nul: "\u0000",
      tagLike: "\u0000D",
      array: ["\u0000D", 1],
      ref: ["\u0000@", 0],
      mid: "a\u0000b",
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it("keeps an own __proto__ key as data without touching prototypes", () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"when":0}') as Record<
      string,
      unknown
    >;
    source.when = new Date(0);
    const result = roundTrip(source);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.when).toEqual(new Date(0));
  });

  it("round-trips null-prototype objects as plain objects", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1n });
    expect(roundTrip(value)).toEqual({ a: 1n });
  });

  it("sends an object with toJSON() as its JSON representation", () => {
    class Money {
      constructor(readonly cents: number) {}
      toJSON() {
        return { cents: this.cents, at: new Date(0) };
      }
    }
    const result = roundTrip({ price: new Money(150), plain: { toJSON: () => "plain" } });
    expect(result.price).toEqual({ cents: 150, at: new Date(0) });
    expect(result.plain).toBe("plain");
  });

  it("does not mutate the encoded input", () => {
    const value = { map: new Map([["a", 1]]), list: [undefined] };
    encodeRouteData(value);
    expect(value.map).toBeInstanceOf(Map);
    expect(value.list).toEqual([undefined]);
  });

  it("never evaluates payload strings", () => {
    const payload = JSON.parse(
      JSON.stringify(encodeRouteData({ code: "globalThis.__pwned = true", pattern: /x/ })),
    );
    decodeRouteData(payload);
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});

describe("encodeRouteData() errors", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["a function", { user: { save() {} } }, /data\.user\.save is a function/],
    ["a symbol", { list: [Symbol("x")] }, /data\.list\[0\] is a symbol/],
    [
      "a class instance",
      { items: [{ value: new (class Money {})() }] },
      /data\.items\[0\]\.value is a Money instance with no toJSON\(\) method/,
    ],
    ["an Error", { error: new Error("x") }, /data\.error is a Error instance/],
    ["a boxed primitive", { s: new String("x") }, /data\.s is a String instance/],
    [
      "a promise",
      { later: Promise.resolve(1) },
      /data\.later is a promise\. Await it, or wrap it in defer\(\)/,
    ],
    ["a quoted key", { "odd key": () => {} }, /data\["odd key"\] is a function/],
    [
      "a Map value",
      { lookup: new Map([["k", () => {}]]) },
      /data\.lookup\.get\("k"\) is a function/,
    ],
    [
      "a Map key",
      { lookup: new Map([[Symbol("k"), 1]]) },
      /data\.lookup\.keys\(\)\[0\] is a symbol/,
    ],
    ["a Set value", { tags: new Set([1, () => {}]) }, /data\.tags\.values\(\)\[1\] is a function/],
    ["the root", () => {}, /: data is a function/],
  ];

  for (const [name, value, message] of cases) {
    it(`names the path to ${name}`, () => {
      expect(() => encodeRouteData(value)).toThrow(message);
    });
  }

  it("names the owner and lists what is supported", () => {
    expect(() => encodeRouteData({ fn() {} }, 'route "blog"')).toThrow(
      /^Loader data for route "blog" cannot be sent to the browser: data\.fn is a function\. Route data may contain JSON values plus undefined, NaN, Infinity, -0, BigInt, Date, RegExp, URL, Map, and Set/,
    );
  });

  it("rejects an unresolved deferred value with a pointed message", () => {
    const deferred = defer(Promise.resolve(1));
    expect(() => encodeRouteData({ nested: new Map([["x", deferred]]) })).toThrow(
      /data\.nested\.get\("x"\) is a deferred value that was not resolved/,
    );
  });

  it("is a TypeError", () => {
    expect(() => encodeRouteData({ fn() {} })).toThrow(TypeError);
  });
});

describe("route data inside an inline script", () => {
  const hostile = {
    close: "</script><script>alert(1)</script>",
    closeUpper: "</SCRIPT>",
    comment: "<!-- <script>",
    separators: "\u2028\u2029",
    amp: "&lt;",
    map: new Map([["</script>", new Set(["<script>"])]]),
    pattern: /<\/script>/,
    link: new URL("https://example.com/?q=</script>"),
    date: new Date(0),
  };

  it("keeps HTML-significant characters and line separators escaped", () => {
    const html = serializeJsonForHtml(encodeRouteData(hostile));
    expect(html).not.toMatch(/<|>|&|\u2028|\u2029/);
    expect(html.toLowerCase()).not.toContain("</script");
  });

  it("round-trips through the escaped form", () => {
    const html = serializeJsonForHtml(encodeRouteData(hostile));
    const result = decodeRouteData<typeof hostile>(JSON.parse(html));
    expect(result.close).toBe(hostile.close);
    expect(result.separators).toBe(hostile.separators);
    expect(result.map.get("</script>")).toEqual(new Set(["<script>"]));
    expect(result.pattern.source).toBe(hostile.pattern.source);
    expect(result.link.href).toBe(hostile.link.href);
  });

  it("is also a safe JavaScript expression for streamed chunks", () => {
    const script = escapeScriptText(JSON.stringify(encodeRouteData(hostile)));
    // oxlint-disable-next-line no-new-func -- test-only check that the literal parses as JS
    const value = new Function(`return (${script});`)() as unknown;
    expect(decodeRouteData<typeof hostile>(value).close).toBe(hostile.close);
  });
});
