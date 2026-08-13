import {
  getRemainingDeclaratorIndices,
  getRemainingSpecifierIndices,
  type StatementState,
} from "./client-module-transform-state.ts";
import {
  collectTopLevelReferences,
  collectVariableDeclaratorDependencies,
  enqueueDependencies,
} from "./client-module-binding-pruning.ts";
import { collectBindingNamesFromPattern, getIdentifierName } from "./scope-analysis-helpers.ts";
import type { OxcNode } from "./scope-analysis-types.ts";

const SERVER_ONLY_EXPORTS = new Set(["loader", "head", "headers", "getStaticPaths", "markdown"]);

/** Mark server-only exports for removal and seed their dependency-pruning worklist. */
export function removeServerOnlyExports(
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
          collectVariableDeclaratorDependencies(
            declarator,
            declaration.kind as string,
            initialBindingNames,
            declaredNames,
          ),
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
        if (localName) candidates.add(localName);
      }
      state.removedSpecifiers.add(index);
    }

    if (getRemainingSpecifierIndices(state).length === 0) {
      state.removed = true;
    }
  }

  return { changed, candidates };
}
