import { defineCommand } from "citty";
import consola from "consola";

import { runDoctor } from "../verification.js";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Validate app wiring",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
  },
  run({ args }) {
    const report = runDoctor(process.cwd());

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      consola.box(`Pracht doctor (${report.mode} mode)`);
      for (const check of report.checks) {
        const icon =
          check.status === "ok" ? "success" : check.status === "warning" ? "warn" : "error";
        consola[icon](check.message);
      }
      if (report.ok) {
        consola.success("No blocking issues found.");
      } else {
        consola.error("Blocking issues found.");
      }
    }

    if (!report.ok) {
      process.exitCode = 1;
    }
  },
});
