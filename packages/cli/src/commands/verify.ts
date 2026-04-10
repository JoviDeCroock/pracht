import { defineCommand } from "citty";
import consola from "consola";

import { runVerification } from "../verification.js";

export const verifyCommand = defineCommand({
  meta: {
    name: "verify",
    description: "Fast framework-aware verification",
  },
  args: {
    changed: {
      type: "boolean",
      description: "Only verify changed files",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
  },
  run({ args }) {
    const report = runVerification(process.cwd(), { changed: args.changed });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      consola.box(`Pracht verify (${report.mode} mode, ${report.scope} scope)`);
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
