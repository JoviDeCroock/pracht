import { findStringEnd } from "./strings.ts";

const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "<",
  ">",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
]);
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
]);
const REGEX_STATEMENT_CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);

interface LexicalToken {
  kind: "atom" | "punctuation" | "word";
  value: string;
}

/**
 * Whether `closeIndex` closes a control-flow condition whose body may begin
 * with a regex expression statement (`if (condition) /pattern/.test(value)`).
 *
 * A closing parenthesis normally makes the following slash division. Control
 * statements are the exception, so retain just enough token context while
 * matching parentheses to distinguish them from calls such as `fn() / 2`.
 */
function closesRegexStatementControlParen(source: string, closeIndex: number): boolean {
  const controlParens: boolean[] = [];
  const tokens: LexicalToken[] = [];

  const record = (token: LexicalToken): void => {
    tokens.push(token);
    if (tokens.length > 2) tokens.shift();
  };

  for (let index = 0; index <= closeIndex; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) continue;

    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return false;
      record({ kind: "atom", value: "string" });
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 1;
      continue;
    }
    if (char === "/") {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        record({ kind: "atom", value: "regex" });
        index = end - 1;
        continue;
      }
      record({ kind: "punctuation", value: char });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      record({ kind: "word", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
      record({ kind: "atom", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (char === "(") {
      const previous = tokens[tokens.length - 1];
      const beforePrevious = tokens[tokens.length - 2];
      const followsControlKeyword =
        previous?.kind === "word" &&
        (REGEX_STATEMENT_CONTROL_KEYWORDS.has(previous.value) ||
          (previous.value === "await" &&
            beforePrevious?.kind === "word" &&
            beforePrevious.value === "for")) &&
        beforePrevious?.value !== ".";
      controlParens.push(followsControlKeyword);
      record({ kind: "punctuation", value: char });
      continue;
    }
    if (char === ")") {
      const closesControl = controlParens.pop() ?? false;
      if (index === closeIndex) return closesControl;
      record({ kind: "punctuation", value: char });
      continue;
    }

    record({ kind: "punctuation", value: char });
  }

  return false;
}

/**
 * If the `/` at `slashIndex` begins a regex literal (decided from the previous
 * significant token, the standard divide-vs-regex heuristic), return the index
 * just after its closing `/` and flags; otherwise -1. Keeps the brace/comma
 * scanners from miscounting a `}`/`]`/`,` inside a regex such as `/\}/`.
 */
export function regexLiteralEnd(source: string, slashIndex: number): number {
  let back = slashIndex - 1;
  while (back >= 0 && /\s/.test(source[back])) back -= 1;
  let isRegex: boolean;
  if (back < 0) {
    isRegex = true;
  } else {
    const prev = source[back];
    if (REGEX_PRECEDING_PUNCTUATION.has(prev)) {
      isRegex = true;
    } else if (prev === ")" && closesRegexStatementControlParen(source, back)) {
      isRegex = true;
    } else if (/[A-Za-z0-9_$]/.test(prev)) {
      let wordStart = back;
      while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
      isRegex = REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart + 1, back + 1));
    } else {
      // Non-control `)`, `]`, `.`, numbers → division operator, not a regex.
      isRegex = false;
    }
  }
  if (!isRegex) return -1;

  let index = slashIndex + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return -1;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
}
