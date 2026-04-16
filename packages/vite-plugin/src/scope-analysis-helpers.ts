import { SKIPPED_KEYS, type OxcNode } from "./scope-analysis-types.ts";

export function getStatementDeclaration(statement: OxcNode): OxcNode | null {
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

export function collectBindingNamesFromPattern(pattern: OxcNode | null | undefined): string[] {
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

export function getIdentifierName(node: OxcNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return node.name as string;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value as string;
  }
  return null;
}

export function isNode(value: unknown): value is OxcNode {
  return !!value && typeof value === "object" && "type" in value;
}

export function getTsRuntimeChildren(node: OxcNode): OxcNode[] {
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

export function collectFunctionScopedVarBindings(node: OxcNode | null | undefined): Set<string> {
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
    for (const child of getTsRuntimeChildren(node)) {
      collectFunctionScopedVarBindingsInto(child, names);
    }
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
