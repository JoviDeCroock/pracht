import { defineCommand } from "citty";

import { runVerification } from "../verification.js";

export default defineCommand({
  meta: {
    name: "verify",
    description: "Fast framework-aware verification",
  },
  args: {
    changed: {
      type: "boolean",
      description: "Only check changed files",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const report = runVerification(process.cwd(), { changed: Boolean(args.changed) });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Pracht verify (${report.mode} mode, ${report.scope} scope)`);
      for (const check of report.checks) {
        console.log(`${check.status.toUpperCase().padEnd(7)} ${check.message}`);
      }
      console.log(report.ok ? "\nNo blocking issues found." : "\nBlocking issues found.");
    }

    if (!report.ok) {
      process.exitCode = 1;
    }
  },
});
