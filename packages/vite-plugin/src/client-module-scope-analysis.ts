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

type BindingKind =
  | "catch"
  | "class"
  | "const"
  | "function"
  | "import"
  | "let"
  | "param"
  | "placeholder"
  | "var";

type ScopeType = "block" | "catch" | "class" | "for" | "function" | "program" | "switch";

export type OxcNode = {
  end: number;
  start: number;
  type: string;
  [key: string]: any;
};

export type Scope = {
  bindings: Map<string, Binding>;
  node: OxcNode | null;
  parent: Scope | null;
  type: ScopeType;
};

export type Binding = {
  kind: BindingKind;
  name: string;
  node: OxcNode | null;
  scope: Scope;
};

export type Reference = {
  name: string;
  node: OxcNode;
  resolvedBinding: Binding | null;
};

export type RetainedStatement = {
  node: OxcNode;
};

export type ScopeAnalysisResult = {
  programScope: Scope;
  referencedTopLevelNames: Set<string>;
  references: Reference[];
};

type AnalyzeScopeOptions = {
  excludedNames?: Iterable<string>;
  knownTopLevelNames?: Iterable<string>;
};

export function analyzeRetainedStatements(
  statements: RetainedStatement[],
  options: AnalyzeScopeOptions = {},
): ScopeAnalysisResult {
  const programScope = createScope("program", null, null);

  for (const name of options.knownTopLevelNames ?? []) {
    declareBinding(programScope, name, "placeholder", null);
  }

  const scopesByNode = new WeakMap<OxcNode, Scope>();
  declareProgramScopes(statements, programScope, scopesByNode);

  const result: ScopeAnalysisResult = {
    programScope,
    referencedTopLevelNames: new Set<string>(),
    references: [],
  };
  const excludedNames = new Set(options.excludedNames);

  for (const statement of statements) {
    collectStatementReferences(statement.node, programScope, scopesByNode, result, excludedNames);
  }

  return result;
}

function createScope(type: ScopeType, parent: Scope | null, node: OxcNode | null): Scope {
  return {
    bindings: new Map<string, Binding>(),
    node,
    parent,
    type,
  };
}

function declareProgramScopes(
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
    declareTsRuntimeChildren(node, currentScope, scopesByNode);
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

function declareBinding(
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

function collectStatementReferences(
  statement: OxcNode,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  if (statement.type === "ImportDeclaration") return;

  if (statement.type === "ExportNamedDeclaration") {
    const declaration = statement.declaration as OxcNode | null;
    if (declaration) {
      collectNodeReferences(declaration, currentScope, scopesByNode, result, excludedNames);
    }
    return;
  }

  if (statement.type === "ExportDefaultDeclaration") {
    const declaration = statement.declaration as OxcNode;
    if (declaration.type !== "Identifier") {
      collectNodeReferences(declaration, currentScope, scopesByNode, result, excludedNames);
    }
    return;
  }

  collectNodeReferences(statement, currentScope, scopesByNode, result, excludedNames);
}

function collectNodeReferences(
  node: OxcNode | null | undefined,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) {
    collectTsRuntimeReferences(node, currentScope, scopesByNode, result, excludedNames);
    return;
  }

  switch (node.type) {
    case "Identifier":
      recordReference(node.name as string, node, currentScope, result, excludedNames);
      return;
    case "JSXIdentifier":
      if (JSX_COMPONENT_RE.test(node.name as string)) {
        recordReference(node.name as string, node, currentScope, result, excludedNames);
      }
      return;
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "FunctionExpression": {
      const functionScope = scopesByNode.get(node) ?? currentScope;

      for (const param of node.params as OxcNode[]) {
        collectPatternReferences(param, functionScope, scopesByNode, result, excludedNames);
      }
      collectNodeReferences(
        node.body as OxcNode,
        functionScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    }
    case "BlockStatement": {
      const blockScope = scopesByNode.get(node) ?? currentScope;

      for (const statement of node.body as OxcNode[]) {
        collectStatementReferences(statement, blockScope, scopesByNode, result, excludedNames);
      }
      return;
    }
    case "CatchClause": {
      const catchScope = scopesByNode.get(node) ?? currentScope;

      if (node.param) {
        collectPatternReferences(
          node.param as OxcNode,
          catchScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      collectNodeReferences(node.body as OxcNode, catchScope, scopesByNode, result, excludedNames);
      return;
    }
    case "ForStatement": {
      const loopScope = scopesByNode.get(node) ?? currentScope;

      collectNodeReferences(
        node.init as OxcNode | null,
        loopScope,
        scopesByNode,
        result,
        excludedNames,
      );
      collectNodeReferences(
        node.test as OxcNode | null,
        loopScope,
        scopesByNode,
        result,
        excludedNames,
      );
      collectNodeReferences(
        node.update as OxcNode | null,
        loopScope,
        scopesByNode,
        result,
        excludedNames,
      );
      collectNodeReferences(node.body as OxcNode, loopScope, scopesByNode, result, excludedNames);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const loopScope = scopesByNode.get(node) ?? currentScope;

      collectNodeReferences(node.left as OxcNode, loopScope, scopesByNode, result, excludedNames);
      collectNodeReferences(node.right as OxcNode, loopScope, scopesByNode, result, excludedNames);
      collectNodeReferences(node.body as OxcNode, loopScope, scopesByNode, result, excludedNames);
      return;
    }
    case "SwitchStatement": {
      collectNodeReferences(
        node.discriminant as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );

      const switchScope = scopesByNode.get(node) ?? currentScope;
      for (const switchCase of node.cases as OxcNode[]) {
        collectNodeReferences(
          switchCase.test as OxcNode | null,
          switchScope,
          scopesByNode,
          result,
          excludedNames,
        );
        for (const statement of switchCase.consequent as OxcNode[]) {
          collectStatementReferences(statement, switchScope, scopesByNode, result, excludedNames);
        }
      }
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      collectNodeReferences(
        node.superClass as OxcNode | null,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );

      const classScope = scopesByNode.get(node) ?? currentScope;
      collectNodeReferences(node.body as OxcNode, classScope, scopesByNode, result, excludedNames);
      return;
    }
    case "VariableDeclaration":
      for (const declarator of node.declarations as OxcNode[]) {
        collectVariableDeclaratorReferences(
          declarator,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      return;
    case "MemberExpression":
      collectNodeReferences(
        node.object as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      if (node.computed) {
        collectNodeReferences(
          node.property as OxcNode,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      return;
    case "MetaProperty":
      return;
    case "LabeledStatement":
      collectNodeReferences(
        node.body as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "Property":
      if (node.computed) {
        collectNodeReferences(
          node.key as OxcNode,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      collectNodeReferences(
        node.value as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "ObjectPattern":
    case "ArrayPattern":
    case "AssignmentPattern":
    case "RestElement":
      collectPatternReferences(node, currentScope, scopesByNode, result, excludedNames);
      return;
    case "JSXElement":
      collectNodeReferences(
        node.openingElement as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      for (const child of node.children as OxcNode[]) {
        collectNodeReferences(child, currentScope, scopesByNode, result, excludedNames);
      }
      return;
    case "JSXFragment":
      for (const child of node.children as OxcNode[]) {
        collectNodeReferences(child, currentScope, scopesByNode, result, excludedNames);
      }
      return;
    case "JSXOpeningElement":
      collectNodeReferences(
        node.name as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      for (const attribute of node.attributes as OxcNode[]) {
        collectNodeReferences(attribute, currentScope, scopesByNode, result, excludedNames);
      }
      return;
    case "JSXClosingElement":
      collectNodeReferences(
        node.name as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "JSXAttribute":
      collectNodeReferences(
        node.value as OxcNode | null,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "JSXExpressionContainer":
      collectNodeReferences(
        node.expression as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "JSXMemberExpression":
      collectNodeReferences(
        node.object as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) {
        collectNodeReferences(
          node.key as OxcNode,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      collectNodeReferences(
        node.value as OxcNode | null,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "ImportDeclaration":
      return;
    case "ExportNamedDeclaration":
      if (node.declaration) {
        collectNodeReferences(
          node.declaration as OxcNode,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      return;
    case "ExportDefaultDeclaration":
      if ((node.declaration as OxcNode).type !== "Identifier") {
        collectNodeReferences(
          node.declaration as OxcNode,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      return;
    default:
      for (const [key, value] of Object.entries(node)) {
        if (SKIPPED_KEYS.has(key)) continue;
        if (key === "id" || key === "implements" || key === "superTypeArguments") continue;
        collectUnknownValueReferences(value, currentScope, scopesByNode, result, excludedNames);
      }
  }
}

function collectUnknownValueReferences(
  value: unknown,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUnknownValueReferences(item, currentScope, scopesByNode, result, excludedNames);
    }
    return;
  }

  if (!isNode(value)) return;
  collectNodeReferences(value, currentScope, scopesByNode, result, excludedNames);
}

function collectVariableDeclaratorReferences(
  declarator: OxcNode,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  collectPatternReferences(
    declarator.id as OxcNode,
    currentScope,
    scopesByNode,
    result,
    excludedNames,
  );
  collectNodeReferences(
    declarator.init as OxcNode | null,
    currentScope,
    scopesByNode,
    result,
    excludedNames,
  );
}

function collectPatternReferences(
  node: OxcNode | null | undefined,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) {
    collectTsRuntimeReferences(node, currentScope, scopesByNode, result, excludedNames);
    return;
  }

  switch (node.type) {
    case "AssignmentPattern":
      collectNodeReferences(
        node.right as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      collectPatternReferences(
        node.left as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    case "ObjectPattern":
      for (const property of node.properties as OxcNode[]) {
        if (property.type === "Property") {
          if (property.computed) {
            collectNodeReferences(
              property.key as OxcNode,
              currentScope,
              scopesByNode,
              result,
              excludedNames,
            );
          }
          collectPatternReferences(
            property.value as OxcNode,
            currentScope,
            scopesByNode,
            result,
            excludedNames,
          );
          continue;
        }

        collectPatternReferences(
          property.argument as OxcNode,
          currentScope,
          scopesByNode,
          result,
          excludedNames,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements as Array<OxcNode | null>) {
        collectPatternReferences(element, currentScope, scopesByNode, result, excludedNames);
      }
      return;
    case "RestElement":
      collectPatternReferences(
        node.argument as OxcNode,
        currentScope,
        scopesByNode,
        result,
        excludedNames,
      );
      return;
    default:
      return;
  }
}

function recordReference(
  name: string,
  node: OxcNode,
  currentScope: Scope,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  const resolvedBinding = resolveBinding(name, currentScope);
  result.references.push({
    name,
    node,
    resolvedBinding,
  });

  if (!resolvedBinding) return;
  if (resolvedBinding.scope.type !== "program") return;
  if (excludedNames.has(name)) return;

  result.referencedTopLevelNames.add(name);
}

function resolveBinding(name: string, currentScope: Scope): Binding | null {
  let scope: Scope | null = currentScope;

  while (scope) {
    const binding = scope.bindings.get(name);
    if (binding) {
      return binding;
    }

    scope = scope.parent;
  }

  return null;
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
  if (node.type.startsWith("TS")) {
    collectFunctionScopedVarBindingsFromTsNode(node, names);
    return;
  }

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

function declareTsRuntimeChildren(
  node: OxcNode,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
): void {
  for (const child of getTsRuntimeChildren(node)) {
    declareNodeScopes(child, currentScope, scopesByNode);
  }
}

function collectTsRuntimeReferences(
  node: OxcNode,
  currentScope: Scope,
  scopesByNode: WeakMap<OxcNode, Scope>,
  result: ScopeAnalysisResult,
  excludedNames: Set<string>,
): void {
  for (const child of getTsRuntimeChildren(node)) {
    collectNodeReferences(child, currentScope, scopesByNode, result, excludedNames);
  }
}

function collectFunctionScopedVarBindingsFromTsNode(node: OxcNode, names: Set<string>): void {
  for (const child of getTsRuntimeChildren(node)) {
    collectFunctionScopedVarBindingsInto(child, names);
  }
}

function getTsRuntimeChildren(node: OxcNode): OxcNode[] {
  switch (node.type) {
    case "TSAsExpression":
    case "TSInstantiationExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
      return [node.expression as OxcNode];
    default:
      return [];
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

function isNode(value: unknown): value is OxcNode {
  return !!value && typeof value === "object" && "type" in value;
}
