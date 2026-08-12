import { describe, expect, it } from "vitest";

import {
  evaluateLiteral,
  findMatchingBrace,
  maskCommentsAndStrings,
  skipToTopLevelComma,
} from "../src/static-source-parser.ts";

describe("static source parser", () => {
  it("masks lexical noise without shifting source offsets", () => {
    const source = [
      'const decoy = "defineCapability({})";',
      "// defineCapability({ commented: true })",
      "const ratio = total / count;",
      "if (ready) /[},]/.test(value);",
    ].join("\n");

    const masked = maskCommentsAndStrings(source);

    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("defineCapability");
    expect(masked).not.toContain("[},]");
    expect(masked).toContain("total / count");
  });

  it("matches braces across nested templates and regular expressions", () => {
    const source =
      '{ run() { return `${/[}]/.test(value) ? "}" : `${value}`}`; }, effect: "read" }';

    expect(findMatchingBrace(source, 0, "{", "}")).toBe(source.length - 1);
  });

  it("finds top-level commas without stopping inside nested syntax", () => {
    const source = 'run: () => /[,}]/.test(value), effect: "read"';
    const comma = skipToTopLevelComma(source, 0);

    expect(source.slice(comma + 1).trimStart()).toBe('effect: "read"');
  });

  it("parses data literals with comments, trailing commas, and Unicode escapes", () => {
    expect(
      evaluateLiteral(String.raw`{
        // schema metadata
        type: "object",
        enum: ["\u{1F600}", null, true, -1.5e2,],
      }`),
    ).toEqual({ type: "object", enum: ["😀", null, true, -150] });
  });

  it("rejects syntax that would require executing application code", () => {
    expect(evaluateLiteral("{ ...shared }")).toBeUndefined();
    expect(evaluateLiteral("{ value: importedValue }")).toBeUndefined();
    expect(evaluateLiteral("`hello ${name}`")).toBeUndefined();
  });
});
