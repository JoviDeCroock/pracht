import type { Binding, OxcNode, Scope, ScopeAnalysisResult } from "./types.ts";

/** Resolve and record an identifier reference against the lexical scope chain. */
export function recordReference(
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
