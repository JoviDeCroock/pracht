import { parseAst } from "vite";

import {
  collectCurrentTopLevelBindingNames,
  pruneDeadBindings,
} from "./client-module-binding-pruning.ts";
import { getRolldownLang } from "./client-module-query.ts";
import { removeServerOnlyExports } from "./client-module-server-exports.ts";
import { renderProgram } from "./client-module-transform-render.ts";
import { createStatementStates } from "./client-module-transform-state.ts";
import type { OxcNode } from "./scope-analysis/types.ts";

export {
  PRACHT_CLIENT_MODULE_QUERY,
  isPrachtClientModuleId,
  stripPrachtClientModuleQuery,
} from "./client-module-query.ts";

export function stripServerOnlyExportsForClient(
  code: string,
  id = "pracht-client-route.tsx",
): string {
  const program = parseAst(code, { lang: getRolldownLang(id) }) as OxcNode;
  const states = createStatementStates(program);
  const initialBindingNames = collectCurrentTopLevelBindingNames(states);
  const { changed, candidates } = removeServerOnlyExports(states, initialBindingNames);

  if (!changed) return code;

  pruneDeadBindings(states, initialBindingNames, candidates);
  return renderProgram(code, states);
}
