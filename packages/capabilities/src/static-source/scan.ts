import { regexLiteralEnd } from "./regex.ts";
import { findStringEnd } from "./strings.ts";

export function skipToTopLevelComma(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return source.length;
      index = end + 1;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index);
      continue;
    }
    if (char === "/") {
      const regexEnd = regexLiteralEnd(source, index);
      if (regexEnd !== -1) {
        index = regexEnd;
        continue;
      }
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) return index;
    index += 1;
  }
  return source.length;
}

export function skipInsignificant(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const blockEnd = source.indexOf("*/", index + 2);
      index = blockEnd === -1 ? source.length : blockEnd + 2;
      continue;
    }
    break;
  }
  return index;
}

/** Find an actual quoted property token, excluding lookalikes inside strings/comments. */
export function findQuotedObjectProperty(source: string, key: string): number | null {
  let index = 0;
  while (index < source.length) {
    const next = skipInsignificant(source, index);
    if (next > index) {
      index = next;
      continue;
    }

    const char = source[index];
    if (char !== '"' && char !== "'" && char !== "`") {
      index += 1;
      continue;
    }

    const end = findStringEnd(source, index);
    if (end === -1) return null;
    if (char !== "`" && source.slice(index + 1, end) === key) {
      const colon = skipInsignificant(source, end + 1);
      const brace = source[colon] === ":" ? skipInsignificant(source, colon + 1) : -1;
      if (brace !== -1 && source[brace] === "{") return index;
    }
    index = end + 1;
  }
  return null;
}

export function findMatchingBrace(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return -1;
      index = end;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index) - 1;
      continue;
    }
    if (char === "/") {
      const regexEnd = regexLiteralEnd(source, index);
      if (regexEnd !== -1) {
        index = regexEnd - 1;
        continue;
      }
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
