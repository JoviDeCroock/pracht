import { parseSizeToBytes } from "./size.js";
import type { BudgetEvaluation, BudgetResult, BundleReport } from "./types.js";

export function evaluateBudgets(
  report: BundleReport,
  budgets: Record<string, string | number>,
): BudgetEvaluation {
  const defaultBudget = budgets["*"];
  const explicitKeys = Object.keys(budgets).filter((key) => key !== "*");
  const routePaths = new Set(report.routes.map((route) => route.path));
  const unmatched = explicitKeys.filter((key) => !routePaths.has(key));

  const results: BudgetResult[] = [];
  for (const route of report.routes) {
    const source = route.path in budgets ? route.path : defaultBudget != null ? "*" : null;
    if (source == null) continue;

    const budget = budgets[source];
    const limitBytes = parseSizeToBytes(budget);
    results.push({
      path: route.path,
      render: route.render,
      budget,
      source,
      limitBytes,
      gzipBytes: route.totalGzipBytes,
      ok: route.totalGzipBytes <= limitBytes,
    });
  }

  return {
    results,
    unmatched,
    ok: results.every((result) => result.ok),
  };
}
