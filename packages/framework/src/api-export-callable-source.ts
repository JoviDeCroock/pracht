/** Conservative callable-default inference for source-only API inspection. */

import { findTopLevelOffsets, hasTopLevelMatch } from "./api-export-source-lexical.ts";

export function hasStaticallyCallableDefaultExport(
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
