import { getTsRuntimeChildren, isNode } from "./scope-analysis-helpers.ts";
import {
  JSX_COMPONENT_RE,
  SKIPPED_KEYS,
  type Binding,
  type OxcNode,
  type Scope,
  type ScopeAnalysisResult,
} from "./scope-analysis-types.ts";

export function collectStatementReferences(
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
    for (const child of getTsRuntimeChildren(node)) {
      collectNodeReferences(child, currentScope, scopesByNode, result, excludedNames);
    }
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
    for (const child of getTsRuntimeChildren(node)) {
      collectNodeReferences(child, currentScope, scopesByNode, result, excludedNames);
    }
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
