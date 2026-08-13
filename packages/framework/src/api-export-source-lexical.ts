/** Offset-preserving JavaScript lexical scanning for API export analysis. */

/** Mark offsets whose token starts in module scope rather than inside nested syntax. */
export function findTopLevelOffsets(source: string): Uint8Array {
  const offsets = new Uint8Array(source.length + 1);
  let nestingDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    offsets[index] = nestingDepth === 0 ? 1 : 0;
    if (source[index] === "{" || source[index] === "(" || source[index] === "[") {
      nestingDepth += 1;
    } else if (source[index] === "}" || source[index] === ")" || source[index] === "]") {
      nestingDepth = Math.max(0, nestingDepth - 1);
    }
  }
  offsets[source.length] = nestingDepth === 0 ? 1 : 0;
  return offsets;
}

export function hasTopLevelMatch(
  source: string,
  pattern: RegExp,
  topLevelOffsets: Uint8Array,
): boolean {
  for (const match of source.matchAll(pattern)) {
    if (topLevelOffsets[match.index ?? 0]) return true;
  }
  return false;
}

/** Mask comments and string contents while preserving offsets and syntax punctuation. */
export function maskJavaScriptCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      if (char === "\\") {
        result += " ";
        result += next === "\n" ? "\n" : next ? " " : "";
        index += 2;
        continue;
      }
      if (char === quote) {
        result += char;
        quote = null;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      result += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        result += "  ";
        index += 2;
      }
      continue;
    }

    if (char === "/" && canStartRegexLiteral(result)) {
      const regexEnd = findRegexLiteralEnd(source, index);
      if (regexEnd !== null) {
        while (index < regexEnd) {
          result += source[index] === "\n" ? "\n" : " ";
          index += 1;
        }
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "default",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const REGEX_CONTROL_KEYWORDS = new Set(["for", "if", "while", "with"]);

/** Decide whether `/` starts an expression rather than dividing one. */
function canStartRegexLiteral(maskedPrefix: string): boolean {
  const prefix = maskedPrefix.trimEnd();
  if (!prefix) return true;
  if (prefix.endsWith("++") || prefix.endsWith("--")) return false;

  const previous = prefix.at(-1) ?? "";
  if ("([{=,:;!?&|+-*%^~<>}".includes(previous)) return true;
  if (previous === ")" && followsControlCondition(prefix)) return true;

  const previousWord = /([A-Za-z_$][\w$]*)$/.exec(prefix)?.[1];
  return previousWord ? REGEX_PREFIX_KEYWORDS.has(previousWord) : false;
}

/** A regex may be the single statement following `if (...)`, `for (...)`, etc. */
function followsControlCondition(prefix: string): boolean {
  let depth = 0;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const char = prefix[index];
    if (char === ")") {
      depth += 1;
      continue;
    }
    if (char !== "(") continue;
    depth -= 1;
    if (depth !== 0) continue;

    const controlPrefix = prefix.slice(0, index).trimEnd();
    const keyword = /([A-Za-z_$][\w$]*)$/.exec(controlPrefix)?.[1];
    return keyword ? REGEX_CONTROL_KEYWORDS.has(keyword) : false;
  }
  return false;
}

/** Return the offset after a complete regex literal and its flags. */
function findRegexLiteralEnd(source: string, start: number): number | null {
  let inCharacterClass = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\n" || char === "\r") return null;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (char !== "/" || inCharacterClass) continue;

    let end = index + 1;
    while (/[A-Za-z]/.test(source[end] ?? "")) end += 1;
    return end;
  }

  return null;
}

export function readStringLiteral(source: string, quoteIndex: number): string | null {
  const quote = source[quoteIndex];
  if (quote !== '"' && quote !== "'") return null;

  let value = "";
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) return value;
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) return null;
      value += escaped;
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") return null;
    value += char;
  }
  return null;
}
