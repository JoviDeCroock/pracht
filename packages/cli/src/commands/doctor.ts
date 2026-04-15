import { defineCommand } from "citty";

import { runDoctor } from "../verification.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Validate app wiring",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const report = runDoctor(process.cwd());

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Pracht doctor (${report.mode} mode)`);
      for (const check of report.checks) {
        console.log(`${check.status.toUpperCase().padEnd(5)} ${check.message}`);
      }
      console.log(report.ok ? "\nNo blocking issues found." : "\nBlocking issues found.");
    }

    if (!report.ok) {
      process.exitCode = 1;
    }
  },
});
