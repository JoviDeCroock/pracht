import { describe, expect, it } from "vitest";

import { evaluateLiteral } from "../src/static-literal.ts";

describe("static literal parsing", () => {
  it("parses nested data with comments and trailing commas", () => {
    expect(
      evaluateLiteral(`{
        // schema metadata
        type: "object",
        enum: [null, true, false, -1.5e2,],
      }`),
    ).toEqual({ type: "object", enum: [null, true, false, -150] });
  });

  it("decodes supported JavaScript string escapes", () => {
    expect(evaluateLiteral(String.raw`["\b\f\n\r\t\v\0", "\x41", "\u0042", "\u{1F600}"]`)).toEqual([
      "\b\f\n\r\t\v\0",
      "A",
      "B",
      "😀",
    ]);
  });

  it("accepts template literals only when they contain no interpolation", () => {
    expect(evaluateLiteral("`static text`")).toBe("static text");
    expect(evaluateLiteral("`hello ${name}`")).toBeUndefined();
  });

  it("rejects syntax that would require executing application code", () => {
    expect(evaluateLiteral("{ ...shared }")).toBeUndefined();
    expect(evaluateLiteral("{ value: importedValue }")).toBeUndefined();
    expect(evaluateLiteral("factory()")).toBeUndefined();
  });

  it("rejects invalid or partial literals", () => {
    expect(evaluateLiteral("trueValue")).toBeUndefined();
    expect(evaluateLiteral("01")).toBeUndefined();
    expect(evaluateLiteral(String.raw`"\u{110000}"`)).toBeUndefined();
    expect(evaluateLiteral("{ value: 1 } trailing")).toBeUndefined();
  });
});
