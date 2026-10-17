import { describe, expect, it } from "vitest";

import { hasControlCharacter } from "../src/control-character.ts";

describe("hasControlCharacter", () => {
  it("flags C0 controls and DEL", () => {
    expect(hasControlCharacter("a\u0000b")).toBe(true);
    expect(hasControlCharacter("line\nbreak")).toBe(true);
    expect(hasControlCharacter("tab\there")).toBe(true);
    expect(hasControlCharacter("del\u007f")).toBe(true);
  });

  it("accepts printable ASCII and non-ASCII text", () => {
    expect(hasControlCharacter("/openapi.json?v=1")).toBe(false);
    expect(hasControlCharacter("café \u{1f600}")).toBe(false);
  });
});
