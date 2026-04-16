import {
  collectBindingNamesFromPattern,
  collectFunctionScopedVarBindings,
  getIdentifierName,
  getStatementDeclaration,
  getTsRuntimeChildren,
  isNode,
} from "./scope-analysis-helpers.ts";
import {
  SKIPPED_KEYS,
  type Binding,
  type BindingKind,
  type OxcNode,
  type RetainedStatement,
  type Scope,
  type ScopeType,
} from "./scope-analysis-types.ts";

export function createScope(type: ScopeType, parent: Scope | null, node: OxcNode | null): Scope {
  return {
    bindings: new Map<string, Binding>(),
    node,
    parent,
    type,
  };
}

export function declareBinding(
  scope: Scope,
  name: string,
  kind: BindingKind,
  node: OxcNode | null,
): Binding {
  const binding: Binding = {
    kind,
    name,
    node,
    scope,
  };

  scope.bindings.set(name, binding);
  return binding;
}

export function declareProgramScopes(
  statements: RetainedStatement[],
  programScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
): void {
  for (const statement of statements) {
    declareTopLevelStatement(statement.node, programScope);
  }

  for (const statement of statements) {
    declareNodeScopes(statement.node, programScope, scopesByNode);
  }
}

function declareTopLevelStatement(statement: OxcNode, programScope: Scope): void {
  if (statement.type === "ImportDeclaration") {
    if (statement.importKind === "type") return;

    for (const specifier of statement.specifiers as OxcNode[]) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;

      const localName = getIdentifierName(specifier.local as OxcNode | null);
      if (localName) {
        declareBinding(programScope, localName, "import", specifier);
      }
    }

    return;
  }

  const declaration = getStatementDeclaration(statement);
  if (!declaration) return;
  declareDeclarationBindings(programScope, declaration);
}

function declareNodeScopes(
  node: OxcNode | null | undefined,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) {
    for (const child of getTsRuntimeChildren(node)) {
      declareNodeScopes(child, currentScope, scopesByNode);
    }
    return;
  }

  switch (node.type) {
    case "ImportDeclaration":
      return;
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "FunctionExpression": {
      const functionScope = createScope("function", currentScope, node);
      scopesByNode.set(node, functionScope);
      declareFunctionBindings(node, functionScope);

      for (const param of node.params as OxcNode[]) {
        declareNodeScopes(param, functionScope, scopesByNode);
      }
      declareNodeScopes(node.body as OxcNode, functionScope, scopesByNode);
      return;
    }
    case "BlockStatement": {
      const blockScope = createScope("block", currentScope, node);
      scopesByNode.set(node, blockScope);
      declareBlockBindings(node.body as OxcNode[], blockScope);

      for (const statement of node.body as OxcNode[]) {
        declareNodeScopes(statement, blockScope, scopesByNode);
      }
      return;
    }
    case "CatchClause": {
      const catchScope = createScope("catch", currentScope, node);
      scopesByNode.set(node, catchScope);
      declareCatchBindings(node, catchScope);

      if (node.param) {
        declareNodeScopes(node.param as OxcNode, catchScope, scopesByNode);
      }
      declareNodeScopes(node.body as OxcNode, catchScope, scopesByNode);
      return;
    }
    case "ForStatement": {
      const init = node.init as OxcNode | null;
      if (init?.type === "VariableDeclaration" && init.kind !== "var") {
        const loopScope = createScope("for", currentScope, node);
        scopesByNode.set(node, loopScope);
        declareDeclarationBindings(loopScope, init);

        declareNodeScopes(init, loopScope, scopesByNode);
        declareNodeScopes(node.test as OxcNode | null, loopScope, scopesByNode);
        declareNodeScopes(node.update as OxcNode | null, loopScope, scopesByNode);
        declareNodeScopes(node.body as OxcNode, loopScope, scopesByNode);
        return;
      }

      declareNodeScopes(init, currentScope, scopesByNode);
      declareNodeScopes(node.test as OxcNode | null, currentScope, scopesByNode);
      declareNodeScopes(node.update as OxcNode | null, currentScope, scopesByNode);
      declareNodeScopes(node.body as OxcNode, currentScope, scopesByNode);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const left = node.left as OxcNode | null;
      if (left?.type === "VariableDeclaration" && left.kind !== "var") {
        const loopScope = createScope("for", currentScope, node);
        scopesByNode.set(node, loopScope);
        declareDeclarationBindings(loopScope, left);

        declareNodeScopes(left, loopScope, scopesByNode);
        declareNodeScopes(node.right as OxcNode, loopScope, scopesByNode);
        declareNodeScopes(node.body as OxcNode, loopScope, scopesByNode);
        return;
      }

      declareNodeScopes(left, currentScope, scopesByNode);
      declareNodeScopes(node.right as OxcNode, currentScope, scopesByNode);
      declareNodeScopes(node.body as OxcNode, currentScope, scopesByNode);
      return;
    }
    case "SwitchStatement": {
      declareNodeScopes(node.discriminant as OxcNode, currentScope, scopesByNode);

      const switchScope = createScope("switch", currentScope, node);
      scopesByNode.set(node, switchScope);
      declareSwitchBindings(node.cases as OxcNode[], switchScope);

      for (const switchCase of node.cases as OxcNode[]) {
        declareNodeScopes(switchCase, switchScope, scopesByNode);
      }
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      declareNodeScopes(node.superClass as OxcNode | null, currentScope, scopesByNode);

      const classScope = createScope("class", currentScope, node);
      scopesByNode.set(node, classScope);

      const name = getIdentifierName(node.id as OxcNode | null);
      if (name) {
        declareBinding(classScope, name, "class", node);
      }

      declareNodeScopes(node.body as OxcNode, classScope, scopesByNode);
      return;
    }
    case "ExportNamedDeclaration":
      if (node.declaration) {
        declareNodeScopes(node.declaration as OxcNode, currentScope, scopesByNode);
      }
      return;
    case "ExportDefaultDeclaration":
      if ((node.declaration as OxcNode).type !== "Identifier") {
        declareNodeScopes(node.declaration as OxcNode, currentScope, scopesByNode);
      }
      return;
    default:
      for (const [key, value] of Object.entries(node)) {
        if (SKIPPED_KEYS.has(key)) continue;
        if (key === "id" || key === "implements" || key === "superTypeArguments") continue;
        declareUnknownValue(value, currentScope, scopesByNode);
      }
  }
}

function declareUnknownValue(
  value: unknown,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      declareUnknownValue(item, currentScope, scopesByNode);
    }
    return;
  }

  if (!isNode(value)) return;
  declareNodeScopes(value, currentScope, scopesByNode);
}

function declareFunctionBindings(node: OxcNode, scope: Scope): void {
  const functionName = getIdentifierName(node.id as OxcNode | null);
  if (functionName) {
    declareBinding(scope, functionName, "function", node);
  }

  for (const param of node.params as OxcNode[]) {
    for (const name of collectBindingNamesFromPattern(param)) {
      declareBinding(scope, name, "param", param);
    }
  }

  for (const name of collectFunctionScopedVarBindings(node.body as OxcNode | null)) {
    declareBinding(scope, name, "var", node.body as OxcNode | null);
  }
}

function declareBlockBindings(statements: OxcNode[], scope: Scope): void {
  for (const statement of statements) {
    const declaration = getStatementDeclaration(statement);
    if (!declaration) continue;

    if (declaration.type === "VariableDeclaration" && declaration.kind === "var") {
      continue;
    }

    declareDeclarationBindings(scope, declaration);
  }
}

function declareCatchBindings(node: OxcNode, scope: Scope): void {
  if (!node.param) return;

  for (const name of collectBindingNamesFromPattern(node.param as OxcNode)) {
    declareBinding(scope, name, "catch", node.param as OxcNode);
  }
}

function declareSwitchBindings(cases: OxcNode[], scope: Scope): void {
  const statements: OxcNode[] = [];

  for (const switchCase of cases) {
    for (const statement of switchCase.consequent as OxcNode[]) {
      statements.push(statement);
    }
  }

  declareBlockBindings(statements, scope);
}

function declareDeclarationBindings(scope: Scope, declaration: OxcNode): void {
  if (declaration.type === "FunctionDeclaration") {
    const name = getIdentifierName(declaration.id as OxcNode | null);
    if (name) {
      declareBinding(scope, name, "function", declaration);
    }
    return;
  }

  if (declaration.type === "ClassDeclaration") {
    const name = getIdentifierName(declaration.id as OxcNode | null);
    if (name) {
      declareBinding(scope, name, "class", declaration);
    }
    return;
  }

  if (declaration.type !== "VariableDeclaration") return;

  for (const declarator of declaration.declarations as OxcNode[]) {
    for (const name of collectBindingNamesFromPattern(declarator.id as OxcNode)) {
      declareBinding(scope, name, declaration.kind as BindingKind, declarator);
    }
  }
}
