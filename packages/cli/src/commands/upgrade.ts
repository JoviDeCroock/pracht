import { defineCommand } from "citty";

import {
  applyCodemods,
  buildUpgradeReport,
  formatUpgradeReport,
  type UpgradeReport,
} from "../deprecations.js";
import { handleCliError } from "../utils.js";

function serializeReport(report: UpgradeReport, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      ok: report.ok,
      packageManager: report.packageManager,
      upgradeCommand: report.upgradeCommand,
      packages: report.packages.map((entry) => ({
        name: entry.name,
        declared: entry.declared,
        version: entry.version,
        deprecations: entry.manifest?.deprecations.length ?? 0,
      })),
      findings: report.findings.map((finding) => ({
        ...finding,
        // The absolute codemod path is an implementation detail of this
        // machine; consumers only need to know whether one exists.
        codemod: finding.codemod !== null,
      })),
      warnings: report.warnings,
      ...extra,
    },
    null,
    2,
  );
}

export default defineCommand({
  meta: {
    name: "upgrade",
    description: "Report deprecated and removed pracht APIs still in use, and migrate them",
  },
  args: {
    check: {
      type: "boolean",
      description: "Exit non-zero when a removed API is still used (for CI)",
    },
    strict: {
      type: "boolean",
      description: "With --check, also fail on deprecations that are not yet removed",
    },
    fix: {
      type: "boolean",
      description: "Apply published codemods for the reported deprecations",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const json = args.json === true;
    try {
      const report = buildUpgradeReport(process.cwd());

      if (args.fix) {
        const result = await applyCodemods(report);
        // Re-scan so the printed report reflects the rewritten source rather
        // than the state that motivated the run.
        const after = buildUpgradeReport(process.cwd());
        if (json) {
          console.log(serializeReport(after, { fixed: result }));
        } else {
          for (const file of result.changedFiles) console.log(`updated  ${file}`);
          for (const skip of result.skipped) console.log(`skipped  ${skip.id} — ${skip.reason}`);
          if (result.changedFiles.length > 0) console.log("");
          console.log(formatUpgradeReport(after));
          console.log("\nReview the changes and run your tests — codemods are textual.");
        }
        if (shouldFail(after, args)) process.exitCode = 1;
        return;
      }

      console.log(json ? serializeReport(report) : formatUpgradeReport(report));
      if (shouldFail(report, args)) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, { json });
    }
  },
});

function shouldFail(report: UpgradeReport, args: { check?: boolean; strict?: boolean }): boolean {
  if (!args.check) return false;
  if (args.strict) return report.findings.length > 0;
  return !report.ok;
}
