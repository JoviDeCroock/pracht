import { parseAst } from "vite";

const CLIENT_MODULE_QUERY = "pracht-client";
const SERVER_ONLY_EXPORTS = new Set(["loader", "head", "headers", "getStaticPaths"]);
const JSX_COMPONENT_RE = /^[A-Z]/;
const SKIPPED_KEYS = new Set([
  "attributes",
  "decorators",
  "end",
  "exportKind",
  "importKind",
  "optional",
  "phase",
  "raw",
  "returnType",
  "start",
  "superTypeArguments",
  "type",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
  "value",
]);

type RolldownLang = "js" | "jsx" | "ts" | "tsx";

type OxcNode = {
  end: number;
  start: number;
  type: string;
  [key: string]: any;
};

type StatementState = {
  node: OxcNode;
  removed: boolean;
  removedDeclarators: Set<number>;
  removedSpecifiers: Set<number>;
};

type BindingInfo = {
  declaratorIndex?: number;
  dependencies: Set<string>;
  kind: "class" | "function" | "import" | "variable";
  names: Set<string>;
  node: OxcNode;
  specifierIndex?: number;
  statementIndex: number;
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

export function stripServerOnlyExportsForClient(
  code: string,
  id = "pracht-client-route.tsx",
): string {
  const program = parseAst(code, { lang: getRolldownLang(id) }) as OxcNode;
  const states = createStatementStates(program);
  const initialBindingNames = collectCurrentTopLevelBindingNames(states);
  const { changed, candidates } = removeServerOnlyExports(states, initialBindingNames);

  if (!changed) return code;

  pruneDeadBindings(states, initialBindingNames, candidates);
  return renderProgram(code, states);
}

function createStatementStates(program: OxcNode): StatementState[] {
  return (program.body as OxcNode[]).map((node) => ({
    node,
    removed: false,
    removedDeclarators: new Set<number>(),
    removedSpecifiers: new Set<number>(),
  }));
}

function removeServerOnlyExports(
  states: StatementState[],
  initialBindingNames: Set<string>,
): { candidates: Set<string>; changed: boolean } {
  let changed = false;
  const candidates = new Set<string>();

  for (const state of states) {
    const statement = state.node;
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") {
      continue;
    }

    const declaration = statement.declaration as OxcNode | null;
    if (declaration?.type === "FunctionDeclaration") {
      const name = declaration.id?.name as string | undefined;
      if (!name || !SERVER_ONLY_EXPORTS.has(name)) continue;

      changed = true;
      state.removed = true;
      enqueueDependencies(
        candidates,
        collectTopLevelReferences(declaration, initialBindingNames, new Set([name])),
      );
      continue;
    }

    if (declaration?.type === "VariableDeclaration") {
      const removable = getRemainingDeclaratorIndices(state).filter((index) =>
        collectBindingNamesFromPattern(declaration.declarations[index].id).some((name) =>
          SERVER_ONLY_EXPORTS.has(name),
        ),
      );

      if (removable.length === 0) continue;

      changed = true;
      for (const index of removable) {
        const declarator = declaration.declarations[index] as OxcNode;
        const declaredNames = new Set(collectBindingNamesFromPattern(declarator.id as OxcNode));
        enqueueDependencies(
          candidates,
          collectVariableDeclaratorDependencies(declarator, initialBindingNames, declaredNames),
        );
        state.removedDeclarators.add(index);
      }

      if (getRemainingDeclaratorIndices(state).length === 0) {
        state.removed = true;
      }

      continue;
    }

    const removableSpecifiers = getRemainingSpecifierIndices(state).filter((index) => {
      const specifier = statement.specifiers[index] as OxcNode;
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") return false;

      const localName = getIdentifierName(specifier.local as OxcNode | null);
      const exportedName = getIdentifierName(specifier.exported as OxcNode | null);
      return (
        SERVER_ONLY_EXPORTS.has(localName ?? "") || SERVER_ONLY_EXPORTS.has(exportedName ?? "")
      );
    });

    if (removableSpecifiers.length === 0) continue;

    changed = true;
    for (const index of removableSpecifiers) {
      const specifier = statement.specifiers[index] as OxcNode;
      if (!statement.source) {
        const localName = getIdentifierName(specifier.local as OxcNode | null);
        if (localName) {
          candidates.add(localName);
        }
      }
      state.removedSpecifiers.add(index);
    }

    if (getRemainingSpecifierIndices(state).length === 0) {
      state.removed = true;
    }
  }

  return { changed, candidates };
}

function pruneDeadBindings(
  states: StatementState[],
  initialBindingNames: Set<string>,
  candidates: Set<string>,
): void {
  let changed = true;

  while (changed) {
    changed = false;

    const bindings = collectTopLevelBindings(states, initialBindingNames);
    const topLevelBindingNames = new Set(bindings.keys());
    const exportedNames = collectExportedBindingNames(states);
    const referencedNames = collectProgramReferences(states, topLevelBindingNames);

    const pendingNames = Array.from(candidates);
    for (const name of pendingNames) {
      const binding = bindings.get(name);
      if (!binding) continue;
      if (exportedNames.has(name) || referencedNames.has(name)) continue;

      removeBinding(states, binding);
      enqueueDependencies(candidates, binding.dependencies);
      changed = true;
    }
  }
}

function collectTopLevelBindings(
  states: StatementState[],
  dependencyBindingNames: Set<string>,
): Map<string, BindingInfo> {
  const bindings = new Map<string, BindingInfo>();

  for (const [statementIndex, state] of states.entries()) {
    if (state.removed) continue;

    const statement = state.node;
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;

      for (const index of getRemainingSpecifierIndices(state)) {
        const specifier = statement.specifiers[index] as OxcNode;
        if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;

        const local = specifier.local as OxcNode | null;
        const name = getIdentifierName(local);
        if (!name) continue;

        const info: BindingInfo = {
          dependencies: new Set<string>(),
          kind: "import",
          names: new Set([name]),
          node: specifier,
          specifierIndex: index,
          statementIndex,
        };
        bindings.set(name, info);
      }

      continue;
    }

    const declaration = getStatementDeclaration(statement);
    if (!declaration) continue;

    if (declaration.type === "FunctionDeclaration") {
      const name = getIdentifierName(declaration.id as OxcNode | null);
      if (!name) continue;

      const info: BindingInfo = {
        dependencies: collectTopLevelReferences(
          declaration,
          dependencyBindingNames,
          new Set([name]),
        ),
        kind: "function",
        names: new Set([name]),
        node: declaration,
        statementIndex,
      };
      bindings.set(name, info);
      continue;
    }

    if (declaration.type === "ClassDeclaration") {
      const name = getIdentifierName(declaration.id as OxcNode | null);
      if (!name) continue;

      const info: BindingInfo = {
        dependencies: collectTopLevelReferences(
          declaration,
          dependencyBindingNames,
          new Set([name]),
        ),
        kind: "class",
        names: new Set([name]),
        node: declaration,
        statementIndex,
      };
      bindings.set(name, info);
      continue;
    }

    if (declaration.type !== "VariableDeclaration") continue;

    for (const index of getRemainingDeclaratorIndices(state)) {
      const declarator = declaration.declarations[index] as OxcNode;
      const names = new Set(collectBindingNamesFromPattern(declarator.id as OxcNode));
      if (names.size === 0) continue;

      const info: BindingInfo = {
        declaratorIndex: index,
        dependencies: collectVariableDeclaratorDependencies(
          declarator,
          dependencyBindingNames,
          names,
        ),
        kind: "variable",
        names,
        node: declarator,
        statementIndex,
      };

      for (const name of names) {
        bindings.set(name, info);
      }
    }
  }

  return bindings;
}

function collectCurrentTopLevelBindingNames(states: StatementState[]): Set<string> {
  const names = new Set<string>();

  for (const state of states) {
    if (state.removed) continue;

    const statement = state.node;
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;

      for (const index of getRemainingSpecifierIndices(state)) {
        const specifier = statement.specifiers[index] as OxcNode;
        if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;

        const localName = getIdentifierName(specifier.local as OxcNode | null);
        if (localName) {
          names.add(localName);
        }
      }

      continue;
    }

    const declaration = getStatementDeclaration(statement);
    if (!declaration) continue;

    if (declaration.type === "VariableDeclaration") {
      for (const index of getRemainingDeclaratorIndices(state)) {
        const declarator = declaration.declarations[index] as OxcNode;
        for (const name of collectBindingNamesFromPattern(declarator.id as OxcNode)) {
          names.add(name);
        }
      }
      continue;
    }

    for (const name of collectBindingNamesFromDeclaration(declaration)) {
      names.add(name);
    }
  }

  return names;
}

function collectExportedBindingNames(states: StatementState[]): Set<string> {
  const names = new Set<string>();

  for (const state of states) {
    if (state.removed) continue;

    const statement = state.node;
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration as OxcNode | null;
      if (declaration) {
        if (declaration.type === "VariableDeclaration") {
          for (const index of getRemainingDeclaratorIndices(state)) {
            const declarator = declaration.declarations[index] as OxcNode;
            for (const name of collectBindingNamesFromPattern(declarator.id as OxcNode)) {
              names.add(name);
            }
          }
        } else {
          for (const name of collectBindingNamesFromDeclaration(declaration)) {
            names.add(name);
          }
        }
      }

      for (const index of getRemainingSpecifierIndices(state)) {
        const specifier = statement.specifiers[index] as OxcNode;
        if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
        const localName = getIdentifierName(specifier.local as OxcNode | null);
        if (localName) {
          names.add(localName);
        }
      }
    }

    if (statement.type !== "ExportDefaultDeclaration") continue;

    const declaration = statement.declaration as OxcNode;
    if (declaration.type === "Identifier") {
      names.add(declaration.name as string);
      continue;
    }

    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id
    ) {
      names.add((declaration.id as OxcNode).name as string);
    }
  }

  return names;
}

function collectProgramReferences(
  states: StatementState[],
  topLevelBindingNames: Set<string>,
): Set<string> {
  const references = new Set<string>();
  const scopeStack: Array<Set<string>> = [];

  for (const state of states) {
    if (state.removed) continue;

    const statement = state.node;
    if (statement.type === "ImportDeclaration") continue;

    if (statement.type === "ExportNamedDeclaration") {
      visitExportNamedDeclaration(statement, state, scopeStack, topLevelBindingNames, references);
      continue;
    }

    if (statement.type === "ExportDefaultDeclaration") {
      visitExportDefaultDeclaration(statement, scopeStack, topLevelBindingNames, references);
      continue;
    }

    visitNode(statement, scopeStack, topLevelBindingNames, references);
  }

  return references;
}

function visitExportNamedDeclaration(
  statement: OxcNode,
  state: StatementState,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
): void {
  const declaration = statement.declaration as OxcNode | null;
  if (!declaration) return;

  if (declaration.type === "VariableDeclaration") {
    for (const index of getRemainingDeclaratorIndices(state)) {
      visitVariableDeclarator(
        declaration.declarations[index] as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
      );
    }
    return;
  }

  visitNode(declaration, scopeStack, topLevelBindingNames, references);
}

function visitExportDefaultDeclaration(
  statement: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
): void {
  const declaration = statement.declaration as OxcNode;
  if (declaration.type === "Identifier") return;
  visitNode(declaration, scopeStack, topLevelBindingNames, references);
}

function removeBinding(states: StatementState[], binding: BindingInfo): void {
  const state = states[binding.statementIndex];
  if (binding.kind === "import" && binding.specifierIndex !== undefined) {
    state.removedSpecifiers.add(binding.specifierIndex);
    if (getRemainingSpecifierIndices(state).length === 0) {
      state.removed = true;
    }
    return;
  }

  if (binding.kind === "variable" && binding.declaratorIndex !== undefined) {
    state.removedDeclarators.add(binding.declaratorIndex);
    if (getRemainingDeclaratorIndices(state).length === 0) {
      state.removed = true;
    }
    return;
  }

  state.removed = true;
}

function renderProgram(code: string, states: StatementState[]): string {
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

function getRemainingDeclaratorIndices(state: StatementState): number[] {
  const declaration = getStatementDeclaration(state.node);
  if (!declaration || declaration.type !== "VariableDeclaration") return [];

  return declaration.declarations
    .map((_item: unknown, index: number) => index)
    .filter((index: number) => !state.removedDeclarators.has(index));
}

function getRemainingSpecifierIndices(state: StatementState): number[] {
  const statement = state.node;
  if (!("specifiers" in statement) || !Array.isArray(statement.specifiers)) return [];

  return statement.specifiers
    .map((_item: unknown, index: number) => index)
    .filter((index: number) => !state.removedSpecifiers.has(index));
}

function collectVariableDeclaratorDependencies(
  declarator: OxcNode,
  topLevelBindingNames: Set<string>,
  excludedNames: Set<string>,
): Set<string> {
  const dependencies = new Set<string>();
  visitPattern(declarator.id as OxcNode, [], topLevelBindingNames, dependencies);
  visitNode(
    declarator.init as OxcNode | null,
    [],
    topLevelBindingNames,
    dependencies,
    excludedNames,
  );
  return dependencies;
}

function collectTopLevelReferences(
  node: OxcNode,
  topLevelBindingNames: Set<string>,
  excludedNames: Set<string>,
): Set<string> {
  const references = new Set<string>();
  visitNode(node, [], topLevelBindingNames, references, excludedNames);
  return references;
}

function visitNode(
  node: OxcNode | null | undefined,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames = new Set<string>(),
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) return;

  switch (node.type) {
    case "Identifier":
      addReference(
        node.name as string,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    case "JSXIdentifier":
      if (JSX_COMPONENT_RE.test(node.name as string)) {
        addReference(
          node.name as string,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "FunctionExpression":
      visitFunctionLike(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "VariableDeclaration":
      for (const declarator of node.declarations as OxcNode[]) {
        visitVariableDeclarator(
          declarator,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    case "MemberExpression":
      visitNode(
        node.object as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      if (node.computed) {
        visitNode(
          node.property as OxcNode,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    case "MetaProperty":
      return;
    case "LabeledStatement":
      visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "Property":
      if (node.computed) {
        visitNode(node.key as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
      }
      if (node.shorthand) {
        visitNode(
          node.value as OxcNode,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      } else {
        visitNode(
          node.value as OxcNode,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    case "BlockStatement":
      visitBlockStatement(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "ObjectPattern":
    case "ArrayPattern":
    case "AssignmentPattern":
    case "RestElement":
      visitPattern(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "CatchClause":
      visitCatchClause(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "ForStatement":
      visitForStatement(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "ForInStatement":
    case "ForOfStatement":
      visitForInOrOfStatement(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "ClassDeclaration":
    case "ClassExpression":
      visitClassLike(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "SwitchStatement":
      visitSwitchStatement(node, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "JSXElement":
      visitNode(
        node.openingElement as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      for (const child of node.children as OxcNode[]) {
        visitNode(child, scopeStack, topLevelBindingNames, references, excludedNames);
      }
      return;
    case "JSXFragment":
      for (const child of node.children as OxcNode[]) {
        visitNode(child, scopeStack, topLevelBindingNames, references, excludedNames);
      }
      return;
    case "JSXOpeningElement":
      visitNode(node.name as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
      for (const attribute of node.attributes as OxcNode[]) {
        visitNode(attribute, scopeStack, topLevelBindingNames, references, excludedNames);
      }
      return;
    case "JSXClosingElement":
      visitNode(node.name as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
      return;
    case "JSXAttribute":
      visitNode(
        node.value as OxcNode | null,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    case "JSXExpressionContainer":
      visitNode(
        node.expression as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    case "JSXMemberExpression":
      visitNode(
        node.object as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) {
        visitNode(node.key as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
      }
      visitNode(
        node.value as OxcNode | null,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    case "ImportDeclaration":
      return;
    case "ExportNamedDeclaration":
      if (node.declaration) {
        visitNode(
          node.declaration as OxcNode,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    case "ExportDefaultDeclaration":
      if ((node.declaration as OxcNode).type !== "Identifier") {
        visitNode(
          node.declaration as OxcNode,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    default:
      for (const [key, value] of Object.entries(node)) {
        if (SKIPPED_KEYS.has(key)) continue;
        if (key === "id" || key === "implements" || key === "superTypeArguments") continue;
        visitUnknownValue(value, scopeStack, topLevelBindingNames, references, excludedNames);
      }
  }
}

function visitUnknownValue(
  value: unknown,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitUnknownValue(item, scopeStack, topLevelBindingNames, references, excludedNames);
    }
    return;
  }

  if (!isNode(value)) return;
  visitNode(value, scopeStack, topLevelBindingNames, references, excludedNames);
}

function visitVariableDeclarator(
  declarator: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames = new Set<string>(),
): void {
  visitPattern(
    declarator.id as OxcNode,
    scopeStack,
    topLevelBindingNames,
    references,
    excludedNames,
  );
  visitNode(
    declarator.init as OxcNode | null,
    scopeStack,
    topLevelBindingNames,
    references,
    excludedNames,
  );
}

function visitFunctionLike(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  const scope = new Set<string>();
  const functionName = getIdentifierName(node.id as OxcNode | null);
  if (functionName) {
    scope.add(functionName);
  }
  for (const param of node.params as OxcNode[]) {
    for (const name of collectBindingNamesFromPattern(param)) {
      scope.add(name);
    }
  }
  for (const name of collectFunctionScopedVarBindings(node.body as OxcNode | null)) {
    scope.add(name);
  }

  scopeStack.push(scope);
  for (const param of node.params as OxcNode[]) {
    visitPattern(param, scopeStack, topLevelBindingNames, references, excludedNames);
  }
  visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
  scopeStack.pop();
}

function visitBlockStatement(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  const scope = collectBlockScopeBindings(node.body as OxcNode[]);
  scopeStack.push(scope);
  for (const statement of node.body as OxcNode[]) {
    visitNode(statement, scopeStack, topLevelBindingNames, references, excludedNames);
  }
  scopeStack.pop();
}

function visitCatchClause(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  const scope = new Set<string>();
  if (node.param) {
    for (const name of collectBindingNamesFromPattern(node.param as OxcNode)) {
      scope.add(name);
    }
  }
  for (const name of collectBlockScopeBindings((node.body as OxcNode).body as OxcNode[])) {
    scope.add(name);
  }

  scopeStack.push(scope);
  if (node.param) {
    visitPattern(
      node.param as OxcNode,
      scopeStack,
      topLevelBindingNames,
      references,
      excludedNames,
    );
  }
  visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
  scopeStack.pop();
}

function visitForStatement(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  const init = node.init as OxcNode | null;
  if (init?.type === "VariableDeclaration" && init.kind !== "var") {
    const scope = new Set(collectBindingNamesFromDeclaration(init));
    scopeStack.push(scope);
    visitNode(init, scopeStack, topLevelBindingNames, references, excludedNames);
    visitNode(
      node.test as OxcNode | null,
      scopeStack,
      topLevelBindingNames,
      references,
      excludedNames,
    );
    visitNode(
      node.update as OxcNode | null,
      scopeStack,
      topLevelBindingNames,
      references,
      excludedNames,
    );
    visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
    scopeStack.pop();
    return;
  }

  visitNode(init, scopeStack, topLevelBindingNames, references, excludedNames);
  visitNode(
    node.test as OxcNode | null,
    scopeStack,
    topLevelBindingNames,
    references,
    excludedNames,
  );
  visitNode(
    node.update as OxcNode | null,
    scopeStack,
    topLevelBindingNames,
    references,
    excludedNames,
  );
  visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
}

function visitForInOrOfStatement(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  const left = node.left as OxcNode | null;
  if (left?.type === "VariableDeclaration" && left.kind !== "var") {
    const scope = new Set(collectBindingNamesFromDeclaration(left));
    scopeStack.push(scope);
    visitNode(left, scopeStack, topLevelBindingNames, references, excludedNames);
    visitNode(node.right as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
    visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
    scopeStack.pop();
    return;
  }

  visitNode(left, scopeStack, topLevelBindingNames, references, excludedNames);
  visitNode(node.right as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
  visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
}

function visitSwitchStatement(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  visitNode(
    node.discriminant as OxcNode,
    scopeStack,
    topLevelBindingNames,
    references,
    excludedNames,
  );

  const scope = collectSwitchScopeBindings(node.cases as OxcNode[]);
  scopeStack.push(scope);
  for (const switchCase of node.cases as OxcNode[]) {
    visitNode(
      switchCase.test as OxcNode | null,
      scopeStack,
      topLevelBindingNames,
      references,
      excludedNames,
    );
    for (const statement of switchCase.consequent as OxcNode[]) {
      visitNode(statement, scopeStack, topLevelBindingNames, references, excludedNames);
    }
  }
  scopeStack.pop();
}

function visitClassLike(
  node: OxcNode,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  visitNode(
    node.superClass as OxcNode | null,
    scopeStack,
    topLevelBindingNames,
    references,
    excludedNames,
  );

  const scope = new Set<string>();
  const name = getIdentifierName(node.id as OxcNode | null);
  if (name) {
    scope.add(name);
  }

  scopeStack.push(scope);
  visitNode(node.body as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
  scopeStack.pop();
}

function visitPattern(
  node: OxcNode | null | undefined,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames = new Set<string>(),
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) return;

  switch (node.type) {
    case "AssignmentPattern":
      visitNode(node.right as OxcNode, scopeStack, topLevelBindingNames, references, excludedNames);
      visitPattern(
        node.left as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    case "ObjectPattern":
      for (const property of node.properties as OxcNode[]) {
        if (property.type === "Property") {
          if (property.computed) {
            visitNode(
              property.key as OxcNode,
              scopeStack,
              topLevelBindingNames,
              references,
              excludedNames,
            );
          }
          visitPattern(
            property.value as OxcNode,
            scopeStack,
            topLevelBindingNames,
            references,
            excludedNames,
          );
          continue;
        }
        visitPattern(
          property.argument as OxcNode,
          scopeStack,
          topLevelBindingNames,
          references,
          excludedNames,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements as Array<OxcNode | null>) {
        visitPattern(element, scopeStack, topLevelBindingNames, references, excludedNames);
      }
      return;
    case "RestElement":
      visitPattern(
        node.argument as OxcNode,
        scopeStack,
        topLevelBindingNames,
        references,
        excludedNames,
      );
      return;
    default:
      return;
  }
}

function collectBlockScopeBindings(statements: OxcNode[]): Set<string> {
  const names = new Set<string>();

  for (const statement of statements) {
    const declaration = getStatementDeclaration(statement);
    if (!declaration) continue;
    if (declaration.type === "VariableDeclaration" && declaration.kind === "var") {
      continue;
    }
    for (const name of collectBindingNamesFromDeclaration(declaration)) {
      names.add(name);
    }
  }

  return names;
}

function collectFunctionScopedVarBindings(node: OxcNode | null | undefined): Set<string> {
  const names = new Set<string>();
  collectFunctionScopedVarBindingsInto(node, names);
  return names;
}

function collectFunctionScopedVarBindingsInto(
  node: OxcNode | null | undefined,
  names: Set<string>,
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) return;

  switch (node.type) {
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return;
    case "VariableDeclaration":
      if (node.kind === "var") {
        for (const declarator of node.declarations as OxcNode[]) {
          for (const name of collectBindingNamesFromPattern(declarator.id as OxcNode)) {
            names.add(name);
          }
        }
      }
      return;
    default:
      for (const [key, value] of Object.entries(node)) {
        if (SKIPPED_KEYS.has(key)) continue;
        if (key === "id" || key === "implements" || key === "superTypeArguments") continue;
        collectFunctionScopedVarBindingsFromUnknown(value, names);
      }
  }
}

function collectFunctionScopedVarBindingsFromUnknown(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFunctionScopedVarBindingsFromUnknown(item, names);
    }
    return;
  }

  if (!isNode(value)) return;
  collectFunctionScopedVarBindingsInto(value, names);
}

function collectSwitchScopeBindings(cases: OxcNode[]): Set<string> {
  const statements: OxcNode[] = [];

  for (const switchCase of cases) {
    for (const statement of switchCase.consequent as OxcNode[]) {
      statements.push(statement);
    }
  }

  return collectBlockScopeBindings(statements);
}

function getStatementDeclaration(statement: OxcNode): OxcNode | null {
  if (statement.type === "ExportNamedDeclaration") {
    return (statement.declaration as OxcNode | null) ?? null;
  }

  if (
    statement.type === "ExportDefaultDeclaration" &&
    ((statement.declaration as OxcNode).type === "FunctionDeclaration" ||
      (statement.declaration as OxcNode).type === "ClassDeclaration")
  ) {
    return statement.declaration as OxcNode;
  }

  if (
    statement.type === "FunctionDeclaration" ||
    statement.type === "ClassDeclaration" ||
    statement.type === "VariableDeclaration"
  ) {
    return statement;
  }

  return null;
}

function collectBindingNamesFromDeclaration(declaration: OxcNode): string[] {
  if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
    return declaration.id ? [(declaration.id as OxcNode).name as string] : [];
  }

  if (declaration.type === "VariableDeclaration") {
    return (declaration.declarations as OxcNode[]).flatMap((declarator) =>
      collectBindingNamesFromPattern(declarator.id as OxcNode),
    );
  }

  return [];
}

function collectBindingNamesFromPattern(pattern: OxcNode | null | undefined): string[] {
  if (!pattern) return [];

  switch (pattern.type) {
    case "Identifier":
      return [pattern.name as string];
    case "AssignmentPattern":
      return collectBindingNamesFromPattern(pattern.left as OxcNode);
    case "RestElement":
      return collectBindingNamesFromPattern(pattern.argument as OxcNode);
    case "ObjectPattern":
      return (pattern.properties as OxcNode[]).flatMap((property) => {
        if (property.type === "Property") {
          return collectBindingNamesFromPattern(property.value as OxcNode);
        }
        return collectBindingNamesFromPattern(property.argument as OxcNode);
      });
    case "ArrayPattern":
      return (pattern.elements as Array<OxcNode | null>).flatMap((element) =>
        collectBindingNamesFromPattern(element),
      );
    default:
      return [];
  }
}

function addReference(
  name: string,
  scopeStack: Array<Set<string>>,
  topLevelBindingNames: Set<string>,
  references: Set<string>,
  excludedNames: Set<string>,
): void {
  if (excludedNames.has(name)) return;
  if (!topLevelBindingNames.has(name)) return;
  if (isShadowed(name, scopeStack)) return;
  references.add(name);
}

function isShadowed(name: string, scopeStack: Array<Set<string>>): boolean {
  return scopeStack.some((scope) => scope.has(name));
}

function enqueueDependencies(target: Set<string>, dependencies: Iterable<string>): void {
  for (const name of dependencies) {
    target.add(name);
  }
}

function getIdentifierName(node: OxcNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return node.name as string;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value as string;
  }
  return null;
}

function getRolldownLang(id: string): RolldownLang {
  const path = stripPrachtClientModuleQuery(id).split("?")[0];
  if (/\.(c|m)?tsx$/i.test(path)) return "tsx";
  if (/\.(c|m)?ts$/i.test(path)) return "ts";
  if (/\.(c|m)?jsx$/i.test(path)) return "jsx";
  if (/\.mdx?$/i.test(path)) return "jsx";
  if (/\.(c|m)?js$/i.test(path)) return "js";
  return "tsx";
}

function isNode(value: unknown): value is OxcNode {
  return !!value && typeof value === "object" && "type" in value;
}
