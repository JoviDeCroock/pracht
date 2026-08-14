import { regexLiteralEnd } from "./regex.ts";
import { findStringEnd } from "./strings.ts";

/**
 * Replace comments, regex literals, and optionally strings with spaces while
 * preserving source offsets. Regex-based entry-point discovery can then only
 * match live code, while the real source remains available for brace-aware
 * extraction.
 */
function maskLexicalNoise(source: string, maskStrings: boolean): string {
  const chars = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return chars.slice(0, index).join("") + " ".repeat(source.length - index);
      if (maskStrings) {
        for (let cursor = index; cursor <= end; cursor += 1) {
          if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
        }
      }
      index = end + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      const limit = end === -1 ? source.length : end;
      for (let cursor = index; cursor < limit; cursor += 1) chars[cursor] = " ";
      index = limit;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const limit = close === -1 ? source.length : close + 2;
      for (let cursor = index; cursor < limit; cursor += 1) {
        if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
      }
      index = limit;
      continue;
    }
    if (char === "/") {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        for (let cursor = index; cursor < end; cursor += 1) {
          if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
        }
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return chars.join("");
}

export function maskComments(source: string): string {
  return maskLexicalNoise(source, false);
}

export function maskCommentsAndStrings(source: string): string {
  return maskLexicalNoise(source, true);
}
