import { describe, expect, it } from "vitest";

import {
  findMatchingBrace,
  maskCommentsAndStrings,
  skipToTopLevelComma,
} from "../src/static-source-lexical.ts";

describe("static source lexical scanning", () => {
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
});
