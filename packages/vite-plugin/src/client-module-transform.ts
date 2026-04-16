const CLIENT_MODULE_QUERY = "pracht-client";
const SERVER_ONLY_EXPORTS = new Set(["loader", "head", "headers", "getStaticPaths"]);

type Range = {
  start: number;
  end: number;
};

export const PRACHT_CLIENT_MODULE_QUERY = `?${CLIENT_MODULE_QUERY}`;

export function isPrachtClientModuleId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;

  return id
    .slice(queryStart + 1)
    .split("&")
    .includes(CLIENT_MODULE_QUERY);
}

export function stripPrachtClientModuleQuery(id: string): string {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return id;

  const path = id.slice(0, queryStart);
  const query = id
    .slice(queryStart + 1)
    .split("&")
    .filter((part) => part !== CLIENT_MODULE_QUERY);

  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}

export function stripServerOnlyExportsForClient(code: string): string {
  const withoutDeclarations = removeRanges(code, collectServerOnlyDeclarationRanges(code));
  const withoutSpecifiers = removeServerOnlyExportSpecifiers(withoutDeclarations);
  return removeUnusedImports(withoutSpecifiers);
}

function collectServerOnlyDeclarationRanges(code: string): Range[] {
  const ranges: Range[] = [];

  const functionRe = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g;
  for (const match of code.matchAll(functionRe)) {
    const name = match[1];
    if (!SERVER_ONLY_EXPORTS.has(name)) continue;
    ranges.push({
      start: match.index ?? 0,
      end: findFunctionDeclarationEnd(code, match.index ?? 0),
    });
  }

  const variableRe = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g;
  for (const match of code.matchAll(variableRe)) {
    const name = match[1];
    if (!SERVER_ONLY_EXPORTS.has(name)) continue;
    ranges.push({
      start: match.index ?? 0,
      end: findStatementEnd(code, match.index ?? 0),
    });
  }

  return ranges;
}

function removeServerOnlyExportSpecifiers(code: string): string {
  return code.replace(
    /\bexport\s+(type\s+)?\{([^}]*)\}(\s+from\s+["'][^"']+["'])?\s*;?/g,
    (statement, typeKeyword: string | undefined, specifierList: string, fromClause = "") => {
      if (typeKeyword) return statement;

      const remaining = specifierList
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .filter((specifier) => {
          const [localName, exportedName = localName] = specifier.split(/\s+as\s+/);
          return (
            !SERVER_ONLY_EXPORTS.has(localName.trim()) &&
            !SERVER_ONLY_EXPORTS.has(exportedName.trim())
          );
        });

      if (remaining.length === 0) return "";

      return `export { ${remaining.join(", ")} }${fromClause};`;
    },
  );
}

function removeUnusedImports(code: string): string {
  const imports = collectImportRanges(code);
  if (imports.length === 0) return code;

  const codeWithoutImports = removeRanges(code, imports);
  const removable = imports.filter((range) => {
    const statement = code.slice(range.start, range.end);
    if (isSideEffectImport(statement) || isTypeOnlyImport(statement)) return false;

    const localNames = getImportLocalNames(statement);
    return (
      localNames.length > 0 &&
      localNames.every((name) => !isIdentifierUsed(codeWithoutImports, name))
    );
  });

  return removeRanges(code, removable);
}

function collectImportRanges(code: string): Range[] {
  const ranges: Range[] = [];
  const importRe = /\bimport\s/g;

  for (const match of code.matchAll(importRe)) {
    const start = match.index ?? 0;
    const end = findStatementEnd(code, start);
    const statement = code.slice(start, end);

    if (isImportDeclaration(statement)) {
      ranges.push({ start, end });
    }
  }

  return ranges;
}

function isImportDeclaration(statement: string): boolean {
  return /^import\s+(?:type\s+)?(?:["']|[\s\S]+\s+from\s+["'])/.test(statement.trim());
}

function isSideEffectImport(statement: string): boolean {
  return /^import\s+["']/.test(statement.trim());
}

function isTypeOnlyImport(statement: string): boolean {
  return /^import\s+type\s+/.test(statement.trim());
}

function getImportLocalNames(statement: string): string[] {
  const trimmed = statement.trim().replace(/;$/, "");
  const fromMatch = /\sfrom\s+["'][^"']+["']$/.exec(trimmed);
  if (!fromMatch) return [];

  const clause = trimmed.slice("import".length, fromMatch.index).trim();
  const withoutType = clause.startsWith("type ") ? clause.slice("type ".length).trim() : clause;
  const names: string[] = [];

  const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(withoutType);
  if (defaultMatch) {
    names.push(defaultMatch[1]);
  }

  const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(withoutType);
  if (namespaceMatch) {
    names.push(namespaceMatch[1]);
  }

  const namedStart = withoutType.indexOf("{");
  const namedEnd = withoutType.lastIndexOf("}");
  if (namedStart !== -1 && namedEnd > namedStart) {
    const namedSpecifiers = withoutType.slice(namedStart + 1, namedEnd).split(",");
    for (const rawSpecifier of namedSpecifiers) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;

      const withoutSpecifierType = specifier.startsWith("type ")
        ? specifier.slice("type ".length).trim()
        : specifier;
      const [, localName = withoutSpecifierType] = withoutSpecifierType.split(/\s+as\s+/);
      const name = localName.trim();

      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        names.push(name);
      }
    }
  }

  return names;
}

function isIdentifierUsed(code: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(code);
}

function removeRanges(code: string, ranges: Range[]): string {
  if (ranges.length === 0) return code;

  return [...ranges]
    .sort((a, b) => b.start - a.start)
    .reduce((current, range) => current.slice(0, range.start) + current.slice(range.end), code);
}

function findFunctionDeclarationEnd(code: string, start: number): number {
  const paramsStart = code.indexOf("(", start);
  if (paramsStart === -1) return findStatementEnd(code, start);

  const paramsEnd = findMatchingDelimiterEnd(code, paramsStart, "(", ")");
  const bodyStart = code.indexOf("{", paramsEnd);
  if (bodyStart === -1) return findStatementEnd(code, start);

  return findMatchingBraceEnd(code, bodyStart);
}

function findStatementEnd(code: string, start: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = start; index < code.length; index += 1) {
    const skipped = skipIgnoredJavaScript(code, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }

    const char = code[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return index + 1;
    }
  }

  return code.length;
}

function findMatchingBraceEnd(code: string, openBraceIndex: number): number {
  return findMatchingDelimiterEnd(code, openBraceIndex, "{", "}");
}

function findMatchingDelimiterEnd(
  code: string,
  openDelimiterIndex: number,
  openDelimiter: string,
  closeDelimiter: string,
): number {
  let depth = 1;

  for (let index = openDelimiterIndex + 1; index < code.length; index += 1) {
    const skipped = skipIgnoredJavaScript(code, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }

    const char = code[index];
    if (char === openDelimiter) depth += 1;
    else if (char === closeDelimiter) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return code.length;
}

function skipIgnoredJavaScript(code: string, start: number): number {
  const char = code[start];
  const next = code[start + 1];

  if (char === "/" && next === "/") {
    const newline = code.indexOf("\n", start + 2);
    return newline === -1 ? code.length : newline;
  }

  if (char === "/" && next === "*") {
    const commentEnd = code.indexOf("*/", start + 2);
    return commentEnd === -1 ? code.length : commentEnd + 2;
  }

  if (char === '"' || char === "'" || char === "`") {
    return skipQuotedString(code, start, char);
  }

  return start;
}

function skipQuotedString(code: string, start: number, quote: string): number {
  for (let index = start + 1; index < code.length; index += 1) {
    const char = code[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
  }

  return code.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
