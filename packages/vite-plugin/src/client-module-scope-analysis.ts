import { createScope, declareBinding, declareProgramScopes } from "./scope-analysis-declare.ts";
import { collectStatementReferences } from "./scope-analysis-references.ts";
import type {
  OxcNode,
  RetainedStatement,
  Scope,
  ScopeAnalysisResult,
} from "./scope-analysis-types.ts";

export type {
  Binding,
  OxcNode,
  Reference,
  RetainedStatement,
  Scope,
  ScopeAnalysisResult,
} from "./scope-analysis-types.ts";

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
