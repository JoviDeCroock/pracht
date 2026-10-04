import { parseAst } from "vite";

import { getRolldownLang } from "./client-module-query.ts";
import {
  collectBindingNamesFromDeclaration,
  createStatementStates,
  getRemainingDeclaratorIndices,
  getRemainingSpecifierIndices,
  normalizeRetainedStatements,
  type BindingInfo,
  type StatementState,
} from "./client-module-transform-state.ts";
import { renderProgram } from "./client-module-transform-render.ts";
import { analyzeRetainedStatements } from "./client-module-scope-analysis.ts";
import {
  collectBindingNamesFromPattern,
  getIdentifierName,
  getStatementDeclaration,
} from "./scope-analysis-helpers.ts";
import type { OxcNode } from "./scope-analysis-types.ts";

export {
  PRACHT_CLIENT_MODULE_QUERY,
  isPrachtClientModuleId,
  stripPrachtClientModuleQuery,
} from "./client-module-query.ts";

const SERVER_ONLY_EXPORTS = new Set(["loader", "head", "headers", "getStaticPaths", "markdown"]);
const APP_ROOT_SERVER_ONLY_EXPORTS = new Set(["dehydrate"]);

export interface StripServerOnlyExportsOptions {
  /** Strip the dedicated pages-router middleware module from the client graph. */
  middleware?: boolean;
  /** Project the `defineApp({ root })` module: strip `dehydrate` instead of route exports. */
  appRoot?: boolean;
}

export function stripServerOnlyExportsForClient(
  code: string,
  id = "pracht-client-route.tsx",
  options: StripServerOnlyExportsOptions = {},
): string {
  const program = parseAst(code, { lang: getRolldownLang(id) }) as OxcNode;
  const states = createStatementStates(program);

  if (options.middleware === true) {
    // `_middleware` is a dedicated server-only module. Removing only its named
    // export still leaves module initialization, side-effect imports, or an
    // unrelated default export in a direct browser import. Erase the complete
    // module so none of those server-only effects can enter the client graph.
    for (const state of states) state.removed = true;
    return renderProgram(code, states);
  }

  const initialBindingNames = collectCurrentTopLevelBindingNames(states);
  const appRoot = options.appRoot === true;
  const { changed, candidates } = removeServerOnlyExports(
    states,
    initialBindingNames,
    appRoot ? APP_ROOT_SERVER_ONLY_EXPORTS : SERVER_ONLY_EXPORTS,
    // `export const { setup, Root, dehydrate, hydrate } = createQueryRoot()` is
    // the documented `@pracht/query` root. Its other bindings are what the
    // browser renders and hydrates with, and they come from the same call, so
    // the declarator stays: dropping it would drop the root, and its
    // initializer ships for those bindings either way.
    { keepSharedDeclarators: appRoot },
  );

  if (!changed) return code;

  pruneDeadBindings(states, initialBindingNames, candidates);
  // A root whose kept code still calls or re-exports `dehydrate` would throw in
  // the browser without it, so it ships whole, as it did before stripping.
  if (appRoot && hasDanglingReferences(states, initialBindingNames)) return code;
  return renderProgram(code, states);
}

/** Whether retained code references a top-level binding the strip removed. */
function hasDanglingReferences(
  states: StatementState[],
  initialBindingNames: Set<string>,
): boolean {
  const remaining = collectCurrentTopLevelBindingNames(states);
  const referenced = analyzeRetainedStatements(normalizeRetainedStatements(states), {
    knownTopLevelNames: initialBindingNames,
  }).referencedTopLevelNames;
  // Scope analysis does not count export specifiers or `export default name`.
  for (const state of states) {
    const statement = state.node;
    if (state.removed) continue;
    if (statement.type === "ExportDefaultDeclaration") {
      const name = getIdentifierName(statement.declaration as OxcNode);
      if (name) referenced.add(name);
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    for (const index of getRemainingSpecifierIndices(state)) {
      const localName = getIdentifierName(statement.specifiers[index].local as OxcNode | null);
      if (localName) referenced.add(localName);
    }
  }
  for (const name of referenced) {
    if (!remaining.has(name)) return true;
  }
  return false;
}

function removeServerOnlyExports(
  states: StatementState[],
  initialBindingNames: Set<string>,
  serverOnlyExports: ReadonlySet<string>,
  { keepSharedDeclarators }: { keepSharedDeclarators: boolean },
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
      if (!name || !serverOnlyExports.has(name)) continue;

      changed = true;
      state.removed = true;
      enqueueDependencies(
        candidates,
        collectTopLevelReferences(declaration, initialBindingNames, new Set([name])),
      );
      continue;
    }

    if (declaration?.type === "VariableDeclaration") {
      const removable = getRemainingDeclaratorIndices(state).filter((index) => {
        const names = collectBindingNamesFromPattern(declaration.declarations[index].id);
        const isServerOnly = (name: string) => serverOnlyExports.has(name);
        return keepSharedDeclarators
          ? names.length > 0 && names.every(isServerOnly)
          : names.some(isServerOnly);
      });

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

      // An export is server-only by the name it is exported as:
      // `export { dehydrate as hydrate }` is the browser's `hydrate`.
      const exportedName = getIdentifierName(specifier.exported as OxcNode | null);
      return serverOnlyExports.has(exportedName ?? "");
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
    const exportedNames = collectExportedBindingNames(states);
    const referencedNames = collectProgramReferences(states);

    const pendingNames = Array.from(candidates);
    for (const name of pendingNames) {
      const binding = bindings.get(name);
      if (!binding) continue;
      // A destructuring declarator binds several names; it is dead only when
      // none of them is still exported or used.
      const isLive = (bound: string) => exportedNames.has(bound) || referencedNames.has(bound);
      if ([...binding.names].some(isLive)) continue;

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
          declaration.kind as string,
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

function collectProgramReferences(states: StatementState[]): Set<string> {
  return analyzeRetainedStatements(normalizeRetainedStatements(states)).referencedTopLevelNames;
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

function collectVariableDeclaratorDependencies(
  declarator: OxcNode,
  declarationKind: string,
  topLevelBindingNames: Set<string>,
  excludedNames: Set<string>,
): Set<string> {
  const declaration: OxcNode = {
    declarations: [declarator],
    end: declarator.end,
    kind: declarationKind,
    start: declarator.start,
    type: "VariableDeclaration",
  };

  return collectTopLevelReferences(declaration, topLevelBindingNames, excludedNames);
}

function collectTopLevelReferences(
  node: OxcNode,
  topLevelBindingNames: Set<string>,
  excludedNames: Set<string>,
): Set<string> {
  return analyzeRetainedStatements([{ node }], {
    excludedNames,
    knownTopLevelNames: topLevelBindingNames,
  }).referencedTopLevelNames;
}

function enqueueDependencies(target: Set<string>, dependencies: Iterable<string>): void {
  for (const name of dependencies) {
    target.add(name);
  }
}
