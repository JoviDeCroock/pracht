/**
 * Static analysis of capability sources — shared by the Vite plugin (client
 * projection codegen) and the CLI (`pracht verify`). Both consumers parse the
 * same `defineCapability({ ... })` call sites without executing application
 * code, so keeping the parser here guarantees the build and verification can
 * never disagree about what is statically analyzable.
 *
 * Constraint this imposes on capability authors: values the tools need
 * (`expose`, `effect`, `input`, string fields) must be inline literals — no
 * imported constants or spreads. `evaluateLiteral()` parses the literal text
 * as data and returns `undefined` for anything else.
 */

/**
 * Extract the argument object text of the *default-exported*
 * `defineCapability({ ... })` call. The runtime resolves a capability module
 * by its default export, so analysis must agree: a helper `defineCapability()`
 * call earlier in the file must not be mistaken for the exported one. Matches
 * the call site (optionally with a type argument), not the import binding.
 */
export function extractDefineCapabilityArgs(source: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const parenIndex = findDefaultExportedCallParen(searchable);
  if (parenIndex === -1) return null;
  const braceStart = searchable.indexOf("{", parenIndex);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

const CALL_SITE = /defineCapability\s*(?:<[^(]*?>)?\s*\(/g;

/**
 * Index of the `(` of the default-exported `defineCapability()` call, or -1
 * when the module has no analyzable default-exported call. Handles
 * `export default defineCapability(...)`, `export default <id>` (with or
 * without a trailing `;`), and `export { <id> as default }`, resolving the
 * identifier to its `const/let/var <id> = defineCapability(...)` declaration.
 * As a backward-compatible fallback, a module with exactly one call site is
 * unambiguous, so its call is used even without an explicit default export.
 */
function findDefaultExportedCallParen(searchable: string): number {
  const direct = /export\s+default\s+defineCapability\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  if (direct && direct.index != null) {
    return direct.index + direct[0].length - 1;
  }

  const localName = defaultExportLocalName(searchable);
  if (localName) {
    const id = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `[^;]*?` (not `[^=]*`) so an arrow-typed annotation like
    // `const cap: () => Cap = defineCapability(...)` is not cut short at the
    // `=` inside `=>`.
    const decl = new RegExp(
      `\\b(?:const|let|var)\\s+${id}\\b[^;]*?=\\s*defineCapability\\s*(?:<[^(]*?>)?\\s*\\(`,
      "g",
    );
    // The default export refers to the MODULE-scope binding; a shadowed
    // declaration inside a function must not win. Prefer the match at brace
    // depth 0.
    for (const match of searchable.matchAll(decl)) {
      if (match.index != null && braceDepthAt(searchable, match.index) === 0) {
        return match.index + match[0].length - 1;
      }
    }
  }

  const calls = [...searchable.matchAll(CALL_SITE)];
  if (calls.length === 1) {
    const only = calls[0];
    return (only.index ?? 0) + only[0].length - 1;
  }
  return -1;
}

/**
 * Brace/paren/bracket nesting depth at `index` in an already comment- and
 * string-masked source. Depth 0 means module scope.
 */
function braceDepthAt(searchable: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = searchable[cursor];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
  }
  return depth;
}

/** Local binding name of a module's default export, or null. */
function defaultExportLocalName(searchable: string): string | null {
  const idMatch = /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(searchable);
  if (idMatch && idMatch[1] !== "defineCapability") {
    return idMatch[1];
  }
  const asDefault = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default\b/.exec(
    searchable,
  );
  return asDefault ? asDefault[1] : null;
}

/**
 * Scan an object literal body for its top-level properties, returning a map
 * of property name → raw value text. Depth-aware and quote/comment-aware so
 * nested schema annotations (e.g. a `description` inside `input`) are never
 * mistaken for capability fields.
 */
export function scanTopLevelProperties(objectBody: string): Map<string, string> {
  const properties = new Map<string, string>();
  let index = 0;

  while (index < objectBody.length) {
    index = skipInsignificant(objectBody, index);
    if (index >= objectBody.length) break;

    // Property key: identifier or quoted string.
    let key: string | null = null;
    const char = objectBody[index];
    if (char === '"' || char === "'") {
      const end = findStringEnd(objectBody, index);
      if (end === -1) break;
      key = objectBody.slice(index + 1, end);
      index = end + 1;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(objectBody.slice(index));
      if (!match) break;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(objectBody, index);
    if (objectBody[index] !== ":") {
      // Shorthand or method definitions — skip to the next top-level comma.
      index = skipToTopLevelComma(objectBody, index) + 1;
      continue;
    }
    index += 1;

    const valueStart = skipInsignificant(objectBody, index);
    const valueEnd = skipToTopLevelComma(objectBody, valueStart);
    properties.set(key, objectBody.slice(valueStart, valueEnd).trim());
    index = valueEnd + 1;
  }

  return properties;
}

/** Parse the `capabilities: { ... }` block of an app manifest source. */
export function extractCapabilityRegistrations(
  manifestSource: string,
): { name: string; file: string }[] {
  const block = findTopLevelObjectProperty(manifestSource, "capabilities");
  if (!block) return [];
  const searchableBlock = maskComments(block);

  const entries: { name: string; file: string }[] = [];
  // Keys are usually quoted ("notes.search"); values are either lazy import
  // functions or plain string paths (post-transform form).
  const pattern =
    /(?:(["'])((?:\\.|(?!\1).)+)\1|([A-Za-z0-9_$]+))\s*:\s*(?:\(\)\s*=>\s*import\(\s*(["'])([^"']+)\4\s*\)|(["'])([^"']+)\6)/g;
  for (const match of searchableBlock.matchAll(pattern)) {
    entries.push({ name: match[2] ?? match[3], file: match[5] ?? match[7] });
  }
  return entries;
}

/**
 * Find the raw text of a top-level-ish `key: { ... }` property anywhere in a
 * source file (used for the manifest's `capabilities` block).
 */
export function findTopLevelObjectProperty(source: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeOnly = maskCommentsAndStrings(source);
  const commentsRemoved = maskComments(source);
  const unquotedMatch = new RegExp(`\\b${escapedKey}\\s*:\\s*\\{`).exec(codeOnly);
  const quotedIndex = findQuotedObjectProperty(source, key);
  const matchIndex = [unquotedMatch?.index, quotedIndex]
    .filter((candidate): candidate is number => candidate !== undefined && candidate !== null)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return null;
  const braceStart = commentsRemoved.indexOf("{", matchIndex);
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

/** Parse an extracted data literal without evaluating application code. */
export function evaluateLiteral(expression: string): unknown {
  const parsed = parseLiteralValue(expression, 0);
  if (!parsed) return undefined;
  const end = skipInsignificant(expression, parsed.index);
  return end === expression.length ? parsed.value : undefined;
}

function skipToTopLevelComma(source: string, start: number): number {
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

function skipInsignificant(source: string, start: number): number {
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

/**
 * Replace comments (and optionally strings) with spaces while preserving
 * source offsets. Regex-based entry-point discovery can then only match live
 * code, while the real source remains available for brace-aware extraction.
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
    index += 1;
  }
  return chars.join("");
}

function maskComments(source: string): string {
  return maskLexicalNoise(source, false);
}

function maskCommentsAndStrings(source: string): string {
  return maskLexicalNoise(source, true);
}

/** Find an actual quoted property token, excluding lookalikes inside strings/comments. */
function findQuotedObjectProperty(source: string, key: string): number | null {
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

/** Index of the closing quote of the string starting at `start`. */
function findStringEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote === "`") return findTemplateEnd(source, start);
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/**
 * Index of the closing backtick of the template literal starting at `start`.
 * Tracks `${ ... }` interpolations (including nested strings and templates
 * inside them) so an inner backtick or `}` does not end the template early.
 */
function findTemplateEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
    if (char === "$" && source[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === '"' || inner === "'" || inner === "`") {
          const end = findStringEnd(source, index);
          if (end === -1) return -1;
          index = end + 1;
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        index += 1;
      }
      if (depth > 0) return -1;
      index -= 1;
    }
  }
  return -1;
}

function findMatchingBrace(source: string, start: number, open: string, close: string): number {
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

/**
 * If the `/` at `slashIndex` begins a regex literal (decided from the previous
 * significant token, the standard divide-vs-regex heuristic), return the index
 * just after its closing `/` and flags; otherwise -1. Keeps the brace/comma
 * scanners from miscounting a `}`/`]`/`,` inside a regex such as `/\}/`.
 */
function regexLiteralEnd(source: string, slashIndex: number): number {
  let back = slashIndex - 1;
  while (back >= 0 && /\s/.test(source[back])) back -= 1;
  let isRegex: boolean;
  if (back < 0) {
    isRegex = true;
  } else {
    const prev = source[back];
    if (REGEX_PRECEDING_PUNCTUATION.has(prev)) {
      isRegex = true;
    } else if (/[A-Za-z0-9_$]/.test(prev)) {
      let wordStart = back;
      while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
      isRegex = REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart + 1, back + 1));
    } else {
      // `)`, `]`, `.`, numbers → division operator, not a regex.
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

interface ParsedLiteral {
  value: unknown;
  index: number;
}

function parseLiteralValue(source: string, start: number): ParsedLiteral | null {
  const index = skipInsignificant(source, start);
  const char = source[index];
  if (char === "{") return parseObjectLiteral(source, index);
  if (char === "[") return parseArrayLiteral(source, index);
  if (char === '"' || char === "'" || char === "`") return parseStringLiteral(source, index);
  if (source.startsWith("true", index)) return parseKeyword(source, index, "true", true);
  if (source.startsWith("false", index)) return parseKeyword(source, index, "false", false);
  if (source.startsWith("null", index)) return parseKeyword(source, index, "null", null);
  return parseNumberLiteral(source, index);
}

function parseObjectLiteral(source: string, start: number): ParsedLiteral | null {
  const value: Record<string, unknown> = {};
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "}") return { value, index: index + 1 };

  while (index < source.length) {
    let key: string | null = null;
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const parsedKey = parseStringLiteral(source, index);
      if (!parsedKey || typeof parsedKey.value !== "string") return null;
      key = parsedKey.value;
      index = parsedKey.index;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      if (!match) return null;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(source, index);
    if (source[index] !== ":") return null;

    const parsedValue = parseLiteralValue(source, index + 1);
    if (!parsedValue) return null;
    value[key] = parsedValue.value;

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "}") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "}") return { value, index: index + 1 };
  }

  return null;
}

function parseArrayLiteral(source: string, start: number): ParsedLiteral | null {
  const value: unknown[] = [];
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "]") return { value, index: index + 1 };

  while (index < source.length) {
    const parsedValue = parseLiteralValue(source, index);
    if (!parsedValue) return null;
    value.push(parsedValue.value);

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "]") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "]") return { value, index: index + 1 };
  }

  return null;
}

function parseStringLiteral(source: string, start: number): ParsedLiteral | null {
  const quote = source[start];
  const end = findStringEnd(source, start);
  if (end === -1) return null;
  const body = source.slice(start + 1, end);
  if (quote === "`" && body.includes("${")) return null;

  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      value += char;
      continue;
    }

    index += 1;
    if (index >= body.length) return null;
    const escaped = body[index];
    switch (escaped) {
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "v":
        value += "\v";
        break;
      case "0":
        value += "\0";
        break;
      case "x": {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case "u": {
        const hex = body.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        value += escaped;
        break;
    }
  }

  return { value, index: end + 1 };
}

function parseKeyword(
  source: string,
  start: number,
  keyword: string,
  value: unknown,
): ParsedLiteral | null {
  const end = start + keyword.length;
  return /[A-Za-z0-9_$]/.test(source[end] ?? "") ? null : { value, index: end };
}

function parseNumberLiteral(source: string, start: number): ParsedLiteral | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));
  if (!match) return null;
  const end = start + match[0].length;
  if (/[A-Za-z0-9_$]/.test(source[end] ?? "")) return null;
  return { value: Number(match[0]), index: end };
}
