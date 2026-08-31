import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";

import { analyzeMigration, formatMigrateReport } from "../migrate.js";
import { ensureTrailingNewline } from "../utils.js";

export default defineCommand({
  meta: {
    name: "migrate",
    description: "Analyse a Next.js app and report what migrating to pracht involves (read-only)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory to analyse (defaults to the current directory)",
      required: false,
    },
    json: {
      type: "boolean",
      description: "Output the report as JSON",
    },
    output: {
      type: "string",
      description: "Write the report to a file instead of stdout",
    },
  },
  async run({ args }) {
    const root = resolve(process.cwd(), args.dir || ".");
    const report = analyzeMigration(root);
    const rendered = args.json ? JSON.stringify(report, null, 2) : formatMigrateReport(report);

    if (args.output) {
      writeFileSync(resolve(process.cwd(), args.output), ensureTrailingNewline(rendered));
      console.log(`Wrote ${args.output}`);
    } else {
      console.log(rendered);
    }

    // A blocker is something the tool could not translate, not a failure of the
    // run — but CI should be able to notice it.
    if (!report.ok) process.exitCode = 1;
  },
});
