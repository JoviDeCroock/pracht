import {
  getRemainingDeclaratorIndices,
  getRemainingSpecifierIndices,
  type StatementState,
} from "./client-module-transform-state.ts";
import { getStatementDeclaration } from "./scope-analysis-helpers.ts";
import type { OxcNode } from "./scope-analysis-types.ts";

export function renderProgram(code: string, states: StatementState[]): string {
  let cursor = 0;
  let out = "";

  for (const state of states) {
    const statement = state.node;
    out += code.slice(cursor, statement.start);
    out += renderStatement(code, state);
    cursor = statement.end;
  }

  out += code.slice(cursor);
  return out;
}

function renderStatement(code: string, state: StatementState): string {
  if (state.removed) return "";

  const statement = state.node;
  const declaration = getStatementDeclaration(statement);

  if (statement.type === "ImportDeclaration" && state.removedSpecifiers.size > 0) {
    return renderImportDeclaration(code, statement, state);
  }

  if (
    statement.type === "ExportNamedDeclaration" &&
    !statement.declaration &&
    state.removedSpecifiers.size > 0
  ) {
    return renderExportSpecifiers(code, statement, state);
  }

  if (declaration?.type === "VariableDeclaration" && state.removedDeclarators.size > 0) {
    return renderVariableDeclaration(code, statement, declaration, state);
  }

  return code.slice(statement.start, statement.end);
}

function renderImportDeclaration(code: string, statement: OxcNode, state: StatementState): string {
  const remaining = getRemainingSpecifierIndices(state).map(
    (index) => statement.specifiers[index] as OxcNode,
  );
  if (remaining.length === 0) return "";

  const defaultSpecifier = remaining.find(
    (specifier) => specifier.type === "ImportDefaultSpecifier",
  );
  const namespaceSpecifier = remaining.find(
    (specifier) => specifier.type === "ImportNamespaceSpecifier",
  );
  const namedSpecifiers = remaining.filter((specifier) => specifier.type === "ImportSpecifier");
  const clauseParts: string[] = [];

  if (defaultSpecifier) {
    clauseParts.push(code.slice(defaultSpecifier.start, defaultSpecifier.end));
  }
  if (namespaceSpecifier) {
    clauseParts.push(code.slice(namespaceSpecifier.start, namespaceSpecifier.end));
  }
  if (namedSpecifiers.length > 0) {
    clauseParts.push(
      `{ ${namedSpecifiers.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ")} }`,
    );
  }

  const importPrefix = ["import"];
  if (statement.importKind === "type") {
    importPrefix.push("type");
  }
  if (typeof statement.phase === "string" && statement.phase.length > 0) {
    importPrefix.push(statement.phase);
  }

  return `${importPrefix.join(" ")} ${clauseParts.join(", ")} from ${code.slice(statement.source.start, statement.end)}`;
}

function renderExportSpecifiers(code: string, statement: OxcNode, state: StatementState): string {
  const remaining = getRemainingSpecifierIndices(state).map(
    (index) => statement.specifiers[index] as OxcNode,
  );
  if (remaining.length === 0) return "";

  const exportPrefix = statement.exportKind === "type" ? "export type" : "export";
  const sourceSuffix = statement.source
    ? ` from ${code.slice(statement.source.start, statement.end)}`
    : ";";
  return `${exportPrefix} { ${remaining.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ")} }${sourceSuffix}`;
}

function renderVariableDeclaration(
  code: string,
  statement: OxcNode,
  declaration: OxcNode,
  state: StatementState,
): string {
  const remaining = getRemainingDeclaratorIndices(state).map(
    (index) => declaration.declarations[index] as OxcNode,
  );
  if (remaining.length === 0) return "";

  const prefix = statement.type === "ExportNamedDeclaration" ? "export " : "";
  return `${prefix}${declaration.kind as string} ${remaining.map((item) => code.slice(item.start, item.end)).join(", ")};`;
}
