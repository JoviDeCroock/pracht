/** Runtime and source-only detection of callable API route exports. */

import type { AppGraphModuleAccess, AppGraphStaticModuleAccess } from "./app-graph.ts";
import type { HttpMethod } from "./types.ts";

export const API_METHOD_ORDER: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export interface ApiRouteExports {
  /** `true` when the module exports a default catch-all request handler. */
  hasDefaultHandler: boolean;
  methods: HttpMethod[];
}

export async function detectApiExports(
  file: string,
  access: AppGraphModuleAccess,
): Promise<ApiRouteExports> {
  try {
    return apiExportsFromModule(await access.loadModule(file));
  } catch {
    let source: string;
    try {
      source = access.readSource(file);
    } catch {
      return { hasDefaultHandler: false, methods: [] };
    }

    const maskedSource = maskJavaScriptCommentsAndStrings(source);
    const topLevelOffsets = findTopLevelOffsets(maskedSource);
    return {
      hasDefaultHandler: hasStaticallyCallableDefaultExport(maskedSource, topLevelOffsets),
      methods: API_METHOD_ORDER.filter((method) =>
        hasTopLevelMatch(
          maskedSource,
          new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`, "g"),
          topLevelOffsets,
        ),
      ),
    };
  }
}

export function apiExportsFromModule(module: Record<string, unknown>): ApiRouteExports {
  return {
    hasDefaultHandler: typeof module.default === "function",
    methods: API_METHOD_ORDER.filter((method) => typeof module[method] === "function"),
  };
}

/** Detect API exports from source text only, following relative star re-exports. */
export async function detectApiExportsStatic(
  file: string,
  access: AppGraphStaticModuleAccess,
  seen: Set<string> = new Set(),
): Promise<ApiRouteExports> {
  if (seen.has(file)) {
    return { hasDefaultHandler: false, methods: [] };
  }
  seen.add(file);

  let rawSource: string;
  try {
    rawSource = access.readSource(file);
  } catch {
    return { hasDefaultHandler: false, methods: [] };
  }
  const source = maskJavaScriptCommentsAndStrings(rawSource);
  const topLevelOffsets = findTopLevelOffsets(source);

  const exportedNames = new Set<string>();
  const hasDefaultHandler = hasStaticallyCallableDefaultExport(source, topLevelOffsets);

  for (const method of API_METHOD_ORDER) {
    if (
      hasTopLevelMatch(
        source,
        new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`, "g"),
        topLevelOffsets,
      )
    ) {
      exportedNames.add(method);
    }
  }

  const namedExportPattern = /\bexport\s*\{([\s\S]*?)\}(?:\s*from\s*["'][^"']+["'])?/g;
  for (const match of source.matchAll(namedExportPattern)) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    for (const entry of match[1].split(",")) {
      const normalized = entry.trim();
      if (!normalized) continue;
      // Inline type-only specifiers (`export { type GET }`) are erased by
      // TypeScript and therefore cannot be API handlers at runtime.
      if (/^type\s+/.test(normalized)) continue;
      const parts = normalized.split(/\s+as\s+/);
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (exportedName !== "default") exportedNames.add(exportedName);
    }
  }

  if (access.resolveModule) {
    const starExportPattern = /\bexport\s*\*\s*from\s*(["'])/g;
    for (const match of source.matchAll(starExportPattern)) {
      if (!topLevelOffsets[match.index ?? 0]) continue;
      const quoteIndex = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
      const specifier = readStringLiteral(rawSource, quoteIndex);
      if (!specifier) continue;
      const resolved = await access.resolveModule(specifier, file);
      if (!resolved) continue;
      const nested = await detectApiExportsStatic(resolved, access, seen);
      for (const method of nested.methods) exportedNames.add(method);
      // `export *` deliberately does not forward a default export.
    }
  }

  return {
    hasDefaultHandler,
    methods: API_METHOD_ORDER.filter((method) => exportedNames.has(method)),
  };
}

/** Recognize default handlers whose callable value is evident from local syntax. */
function hasStaticallyCallableDefaultExport(
  source: string,
  topLevelOffsets: Uint8Array = findTopLevelOffsets(source),
): boolean {
  const directDefaultPatterns = [
    /\bexport\s+default\s+(?:async\s+)?function(?:\s*\*)?(?:\s+[A-Za-z_$][\w$]*)?\s*\(/g,
    /\bexport\s+default\s+(?:async\s+)?(?:[A-Za-z_$][\w$]*|\([^;{}]*\))\s*=>/g,
  ];
  for (const pattern of directDefaultPatterns) {
    if (hasTopLevelMatch(source, pattern, topLevelOffsets)) return true;
  }

  const callableBindings = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    if (
      !isModuleFunctionDeclaration(source, match.index ?? 0, topLevelOffsets) ||
      previousWord(source, match.index ?? 0) === "declare"
    ) {
      continue;
    }
    callableBindings.add(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=\s*(?:async\s+)?function\b/g,
  )) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    callableBindings.add(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=\s*(?:async\s+)?(?:[A-Za-z_$][\w$]*|\([^;{}]*\))\s*=>/g,
  )) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    callableBindings.add(match[1]);
  }

  const defaultIdentifierPattern =
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)(?=[ \t]*(?:;|\r?\n|$))/g;
  for (const match of source.matchAll(defaultIdentifierPattern)) {
    if (topLevelOffsets[match.index ?? 0] && callableBindings.has(match[1])) return true;
  }

  const namedExportPattern = /\bexport\s*\{([\s\S]*?)\}(\s*from\s*["'][^"']*["'])?/g;
  for (const match of source.matchAll(namedExportPattern)) {
    if (!topLevelOffsets[match.index ?? 0] || match[2]) continue;
    for (const entry of match[1].split(",")) {
      const normalized = entry.trim();
      if (!normalized || /^type\s+/.test(normalized)) continue;
      const parts = normalized.split(/\s+as\s+/);
      const localName = parts[0].trim();
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (exportedName === "default" && callableBindings.has(localName)) return true;
    }
  }

  return false;
}

/** Mark offsets whose token starts in module scope rather than inside nested syntax. */
function findTopLevelOffsets(source: string): Uint8Array {
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

function hasTopLevelMatch(source: string, pattern: RegExp, topLevelOffsets: Uint8Array): boolean {
  for (const match of source.matchAll(pattern)) {
    if (topLevelOffsets[match.index ?? 0]) return true;
  }
  return false;
}

function previousWord(source: string, offset: number): string | null {
  return /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, offset))?.[1] ?? null;
}

const MODULE_EXPRESSION_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
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

/** Distinguish a module declaration from a same-depth named function expression. */
function isModuleFunctionDeclaration(
  source: string,
  offset: number,
  topLevelOffsets: Uint8Array,
): boolean {
  if (!topLevelOffsets[offset]) return false;

  const prefix = source.slice(0, offset);
  const trimmed = prefix.trimEnd();
  if (!trimmed || /[;}]$/.test(trimmed)) return true;

  const word = previousWord(source, offset);
  if (word === "export" || word === "default" || word === "declare") return true;

  const whitespace = prefix.slice(trimmed.length);
  if (!/[\r\n]/.test(whitespace)) return false;
  if (/[([{=,:!?&|+\-*%^~<>.]$/.test(trimmed) || /=>\s*$/.test(trimmed)) return false;

  return !MODULE_EXPRESSION_PREFIX_KEYWORDS.has(word ?? "");
}

/** Mask comments and string contents while preserving offsets and syntax punctuation. */
function maskJavaScriptCommentsAndStrings(source: string): string {
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

function readStringLiteral(source: string, quoteIndex: number): string | null {
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

export async function detectApiMethods(
  file: string,
  access: AppGraphModuleAccess,
): Promise<HttpMethod[]> {
  return (await detectApiExports(file, access)).methods;
}
