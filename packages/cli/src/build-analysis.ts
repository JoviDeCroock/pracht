import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectBundleReport,
  evaluateBudgets,
  formatBudgetResults,
  formatBundleReport,
  formatBytes,
  shouldUseColor,
  type BundleReportRoute,
} from "./bundle-report.js";

interface BuildAnalysisOutput {
  error(message: string): void;
  log(message: string): void;
  warn(message: string): void;
}

interface RunBuildAnalysisOptions {
  analyze: boolean;
  analyzeJson: boolean;
  budgetFail: boolean;
  budgets: Record<string, string | number>;
  clientDir: string;
  clientEntryJs: string[];
  color?: boolean;
  islandFiles: string[];
  islandsEntryJs: string[];
  jsManifest: Record<string, string[]>;
  now?: () => Date;
  output?: BuildAnalysisOutput;
  root: string;
  routes: BundleReportRoute[];
}

export interface BuildAnalysisResult {
  shouldFailBuild: boolean;
}

export function runBuildAnalysis(options: RunBuildAnalysisOptions): BuildAnalysisResult {
  const hasBudgets = Object.keys(options.budgets).length > 0;
  if (!options.analyze && !hasBudgets) return { shouldFailBuild: false };

  const output = options.output ?? console;
  const report = collectBundleReport({
    routes: options.routes,
    jsManifest: options.jsManifest,
    clientEntryJs: options.clientEntryJs,
    islandsEntryJs: options.islandsEntryJs,
    islandFiles: options.islandFiles,
    clientDir: options.clientDir,
  });
  const evaluation = hasBudgets ? evaluateBudgets(report, options.budgets) : null;
  const color = options.color ?? shouldUseColor();

  if (options.analyzeJson) {
    output.log(
      JSON.stringify(
        {
          shared: report.shared,
          routes: report.routes,
          ...(evaluation ? { budgets: evaluation } : {}),
        },
        null,
        2,
      ),
    );
  } else if (options.analyze) {
    output.log(`\n${indentBlock(formatBundleReport(report, { color }))}\n`);
  }

  if (!evaluation) return { shouldFailBuild: false };

  writeFileSync(
    resolve(options.root, "dist/server/budget-report.json"),
    `${JSON.stringify(
      {
        generatedAt: (options.now ?? (() => new Date()))().toISOString(),
        budgets: options.budgets,
        results: evaluation.results,
        unmatched: evaluation.unmatched,
        ok: evaluation.ok,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  if (!options.analyzeJson) {
    output.log(`\n${indentBlock(formatBudgetResults(evaluation, { color }))}\n`);
  }
  if (evaluation.ok) return { shouldFailBuild: false };

  const summary = evaluation.results
    .filter((result) => !result.ok)
    .map(
      (result) =>
        `${result.path} (${formatBytes(result.gzipBytes)} gzip > ${formatBytes(result.limitBytes)})`,
    )
    .join(", ");
  if (options.budgetFail) {
    output.error(`\n  Build failed: client JS budget exceeded for ${summary}.\n`);
    return { shouldFailBuild: true };
  }
  if (!options.analyzeJson) {
    output.warn(`\n  Warning: client JS budget exceeded for ${summary} (--no-budget-fail).\n`);
  }
  return { shouldFailBuild: false };
}

function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}
