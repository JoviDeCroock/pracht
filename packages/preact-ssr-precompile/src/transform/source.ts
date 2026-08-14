/** Parsing, AST traversal, and offset-safe source edits for JSX lowering. */

import { parseSync } from "rolldown/utils";
import type { RolldownString } from "rolldown-string";
import { looksLikeJSX, stripQuery } from "../module-source.js";

export type NodeLike = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

export type Replacement = {
  start: number;
  end: number;
  code: string;
};

export function insertPrelude(s: RolldownString, program: NodeLike, prelude: string): void {
  if (prelude.trim() === "") return;

  const insertAt = findPreludeInsertionPoint(s.original, program);
  const needsLeadingNewline = insertAt > 0 && !s.original.slice(0, insertAt).endsWith("\n");
  s.appendLeft(insertAt, `${needsLeadingNewline ? "\n" : ""}${prelude}`);
}

function findPreludeInsertionPoint(code: string, program: NodeLike): number {
  const body = getNodeArray(program.body);
  let insertAt = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;

  for (const statement of body) {
    if (statement.type === "ImportDeclaration") {
      insertAt = Math.max(insertAt, statement.end);
      continue;
    }

    if (statement.type === "ExpressionStatement") {
      const expression = statement.expression as NodeLike | undefined;
      if (expression?.type === "Literal" && typeof expression.value === "string") {
        insertAt = Math.max(insertAt, statement.end);
        continue;
      }
    }

    break;
  }

  while (code[insertAt] === "\r" || code[insertAt] === "\n") insertAt++;
  return insertAt;
}

export function applyReplacementsInRange(
  code: string,
  start: number,
  end: number,
  replacements: Replacement[],
): string {
  let cursor = start;
  let out = "";

  for (const replacement of replacements) {
    if (replacement.start < cursor || replacement.end > end) continue;
    out += code.slice(cursor, replacement.start);
    out += replacement.code;
    cursor = replacement.end;
  }

  out += code.slice(cursor, end);
  return out;
}

export function collectIdentifierNames(node: unknown): Set<string> {
  const names = new Set<string>();

  function visit(value: unknown): void {
    if (!isNode(value)) return;
    if (
      (value.type === "Identifier" || value.type === "JSXIdentifier") &&
      typeof value.name === "string"
    ) {
      names.add(value.name);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "comments") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (isNode(child)) {
        visit(child);
      }
    }
  }

  visit(node);
  return names;
}

export function uniqueName(base: string, takenNames: Set<string>): string {
  let name = base;
  let index = 1;
  while (takenNames.has(name)) {
    name = `${base}_${index++}`;
  }
  takenNames.add(name);
  return name;
}

export function getNodeArray(value: unknown): NodeLike[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

export function isNode(value: unknown): value is NodeLike {
  return !!value && typeof value === "object" && typeof (value as NodeLike).type === "string";
}

export function parseProgram(id: string, code: string): NodeLike {
  const parseOptions = getParseOptions(id, code);
  return parseSync(id, code, {
    lang: parseOptions.lang,
    sourceType: parseOptions.sourceType,
  }).program as unknown as NodeLike;
}

function getParseOptions(
  id: string,
  code: string,
): {
  lang: "js" | "jsx" | "ts" | "tsx";
  sourceType: "module" | "commonjs";
} {
  const filename = stripQuery(id);
  const isCommonJS = /(^|\W)require\s*\(|(^|\W)module\.exports\b|(^|\W)exports\./.test(code);

  let lang: "js" | "jsx" | "ts" | "tsx" = "js";
  if (/\.[cm]?tsx$/i.test(filename)) {
    lang = "tsx";
  } else if (/\.[cm]?ts$/i.test(filename)) {
    lang = looksLikeJSX(code) ? "tsx" : "ts";
  } else if (/\.[cm]?jsx$/i.test(filename)) {
    lang = "jsx";
  } else if (looksLikeJSX(code)) {
    lang = "jsx";
  }

  return {
    lang,
    sourceType: isCommonJS ? "commonjs" : "module",
  };
}
