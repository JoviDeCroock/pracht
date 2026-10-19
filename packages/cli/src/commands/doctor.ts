import { defineCommand } from "citty";

import { handleCliError } from "../utils.js";
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
    let report: Awaited<ReturnType<typeof runDoctor>>;
    try {
      report = await runDoctor(process.cwd());
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }

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
