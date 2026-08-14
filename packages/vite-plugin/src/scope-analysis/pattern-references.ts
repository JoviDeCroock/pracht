import { getTsRuntimeChildren } from "./ast.ts";
import type { OxcNode, Scope } from "./types.ts";

export type NodeReferenceCollector = (
  node: OxcNode | null | undefined,
  currentScope: Scope,
) => void;

/** Collect runtime expressions embedded in declaration and parameter patterns. */
export function collectPatternReferences(
  node: OxcNode | null | undefined,
  currentScope: Scope,
  collectNodeReferences: NodeReferenceCollector,
): void {
  if (!node) return;
  if (node.type.startsWith("TS")) {
    for (const child of getTsRuntimeChildren(node)) {
      collectNodeReferences(child, currentScope);
    }
    return;
  }

  switch (node.type) {
    case "AssignmentPattern":
      collectNodeReferences(node.right as OxcNode, currentScope);
      collectPatternReferences(node.left as OxcNode, currentScope, collectNodeReferences);
      return;
    case "ObjectPattern":
      for (const property of node.properties as OxcNode[]) {
        if (property.type === "Property") {
          if (property.computed) {
            collectNodeReferences(property.key as OxcNode, currentScope);
          }
          collectPatternReferences(property.value as OxcNode, currentScope, collectNodeReferences);
          continue;
        }

        collectPatternReferences(property.argument as OxcNode, currentScope, collectNodeReferences);
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements as Array<OxcNode | null>) {
        collectPatternReferences(element, currentScope, collectNodeReferences);
      }
      return;
    case "RestElement":
      collectPatternReferences(node.argument as OxcNode, currentScope, collectNodeReferences);
      return;
    default:
      return;
  }
}
