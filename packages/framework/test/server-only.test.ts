import { describe, expect, it } from "vitest";

import { readServerOnly, serverOnly, defer } from "../src/index.ts";
import { serverOnly as browserServerOnly } from "../src/browser.ts";
import { isServerOnly, isServerOnlyPlaceholder } from "../src/server-only.ts";
import { stripServerOnlyValues } from "../src/server-only-strip.ts";

describe("serverOnly()", () => {
  it("marks a value without changing what JSON serialization produces", () => {
    const marked = serverOnly("<p>hi</p>");
    expect(isServerOnly(marked)).toBe(true);
    // Route-state responses carry the real value: the page a client-side
    // navigation is moving to has no server-rendered DOM yet.
    expect(JSON.stringify({ html: marked })).toBe('{"html":"<p>hi</p>"}');
  });

  it("reads back through readServerOnly(), and passes plain values through", () => {
    expect(readServerOnly(serverOnly({ rows: [1, 2] }))).toEqual({ rows: [1, 2] });
    expect(readServerOnly("plain")).toBe("plain");
  });

  it("does not double-wrap", () => {
    const once = serverOnly("x");
    expect(serverOnly(once)).toBe(once);
  });

  it("is the real implementation in the browser entry, which edge SSR resolves", () => {
    // `ssr.target: "webworker"` puts `browser` in the condition list, so a
    // Cloudflare server render imports @pracht/core through browser.ts. A stub
    // there would throw while rendering every Markdown route on that adapter.
    expect(isServerOnly(browserServerOnly("<p>hi</p>"))).toBe(true);
    expect(readServerOnly(browserServerOnly("<p>hi</p>"))).toBe("<p>hi</p>");
  });

  it("rejects a defer() marker, which would never survive to serialization", () => {
    expect(() => serverOnly(defer(Promise.resolve(1)))).toThrow(/cannot wrap a defer/);
  });

  it("throws with an actionable message when the browser reads a stripped field", () => {
    const stripped = stripServerOnlyValues({ html: serverOnly("<p>hi</p>") });
    expect(() => readServerOnly(stripped.html)).toThrow(/StaticHtml/);
  });
});

describe("stripServerOnlyValues()", () => {
  it("returns the input untouched when nothing is marked", () => {
    const data = { a: 1, nested: { b: [1, 2] } };
    expect(stripServerOnlyValues(data)).toBe(data);
  });

  it("replaces markers at any depth with a placeholder", () => {
    const data = {
      title: "Post",
      body: serverOnly("<p>hi</p>"),
      nested: { deep: [{ html: serverOnly("<b>x</b>") }] },
    };
    const stripped = stripServerOnlyValues(data);

    expect(JSON.parse(JSON.stringify(stripped))).toEqual({
      title: "Post",
      body: { __prachtServerOnly: true },
      nested: { deep: [{ html: { __prachtServerOnly: true } }] },
    });
    expect(isServerOnlyPlaceholder(stripped.body)).toBe(true);
  });

  it("does not mutate the data the rendered tree closed over", () => {
    const data = { body: serverOnly("<p>hi</p>") };
    stripServerOnlyValues(data);
    expect(isServerOnly(data.body)).toBe(true);
  });

  it("keeps array holes, extra array properties, and prototypes intact", () => {
    const list: unknown[] = [serverOnly("a")];
    list.length = 3;
    (list as unknown as { label: string }).label = "tail";
    const stripped = stripServerOnlyValues({ list }).list as unknown[];

    expect(stripped.length).toBe(3);
    expect(1 in stripped).toBe(false);
    expect((stripped as unknown as { label: string }).label).toBe("tail");
    expect(isServerOnlyPlaceholder(stripped[0])).toBe(true);
  });

  it("does not invoke getters while looking for markers", () => {
    let reads = 0;
    const data = {
      plain: 1,
      get expensive() {
        reads += 1;
        return "computed";
      },
    };
    stripServerOnlyValues(data);
    expect(reads).toBe(0);
  });

  it("terminates on a cycle", () => {
    const data: Record<string, unknown> = { body: serverOnly("<p>hi</p>") };
    data.self = data;
    const stripped = stripServerOnlyValues(data);
    expect(stripped.self).toBe(stripped);
  });

  it("hands non-plain objects back by reference rather than losing their prototype", () => {
    const date = new Date(0);
    const stripped = stripServerOnlyValues({ date, body: serverOnly("x") });
    expect(stripped.date).toBe(date);
  });
});
