import { describe, expect, it } from "vitest";

import { escapeHtml } from "../src/html-escape.ts";

describe("escapeHtml", () => {
  it("escapes ampersands first so existing entities are not left live", () => {
    expect(escapeHtml(`<a href="x">&amp;</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;",
    );
  });

  it("leaves single quotes and plain text unchanged", () => {
    expect(escapeHtml("it's plain")).toBe("it's plain");
  });
});
