import {
  collectBindingNamesFromPattern,
  getStatementDeclaration,
} from "./scope-analysis-helpers.ts";
import type { OxcNode, RetainedStatement } from "./scope-analysis-types.ts";

export type StatementState = {
  node: OxcNode;
  removed: boolean;
  removedDeclarators: Set<number>;
  removedSpecifiers: Set<number>;
};

export type BindingInfo = {
  declaratorIndex?: number;
  dependencies: Set<string>;
  kind: "class" | "function" | "import" | "variable";
  names: Set<string>;
  node: OxcNode;
  specifierIndex?: number;
  statementIndex: number;
};

export function createStatementStates(program: OxcNode): StatementState[] {
  return (program.body as OxcNode[]).map((node) => ({
    node,
    removed: false,
    removedDeclarators: new Set<number>(),
    removedSpecifiers: new Set<number>(),
  }));
}

export function getRemainingDeclaratorIndices(state: StatementState): number[] {
  const declaration = getStatementDeclaration(state.node);
  if (!declaration || declaration.type !== "VariableDeclaration") return [];

  return declaration.declarations
    .map((_item: unknown, index: number) => index)
    .filter((index: number) => !state.removedDeclarators.has(index));
}

export function getRemainingSpecifierIndices(state: StatementState): number[] {
  const statement = state.node;
  if (!("specifiers" in statement) || !Array.isArray(statement.specifiers)) return [];

  return statement.specifiers
    .map((_item: unknown, index: number) => index)
    .filter((index: number) => !state.removedSpecifiers.has(index));
}

export function collectBindingNamesFromDeclaration(declaration: OxcNode): string[] {
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

export function normalizeRetainedStatements(states: StatementState[]): RetainedStatement[] {
  return states
    .map((state) => normalizeRetainedStatement(state))
    .filter((state): state is RetainedStatement => state !== null);
}

function normalizeRetainedStatement(state: StatementState): RetainedStatement | null {
  if (state.removed) return null;

  const statement = state.node;
  if (statement.type === "ImportDeclaration" && state.removedSpecifiers.size > 0) {
    return {
      node: {
        ...statement,
        specifiers: getRemainingSpecifierIndices(state).map(
          (index) => statement.specifiers[index] as OxcNode,
        ),
      },
    };
  }

  if (
    statement.type === "ExportNamedDeclaration" &&
    !statement.declaration &&
    state.removedSpecifiers.size > 0
  ) {
    return {
      node: {
        ...statement,
        specifiers: getRemainingSpecifierIndices(state).map(
          (index) => statement.specifiers[index] as OxcNode,
        ),
      },
    };
  }

  const declaration = getStatementDeclaration(statement);
  if (declaration?.type === "VariableDeclaration" && state.removedDeclarators.size > 0) {
    const retainedDeclaration: OxcNode = {
      ...declaration,
      declarations: getRemainingDeclaratorIndices(state).map(
        (index) => declaration.declarations[index] as OxcNode,
      ),
    };

    if (statement.type === "ExportNamedDeclaration") {
      return {
        node: {
          ...statement,
          declaration: retainedDeclaration,
        },
      };
    }

    return { node: retainedDeclaration };
  }

  return { node: statement };
}
