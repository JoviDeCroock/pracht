import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";

import { DEFAULT_BASE_REF } from "../plan.js";
import { runReport } from "../report.js";
import { ensureTrailingNewline, handleCliError } from "../utils.js";

export default defineCommand({
  meta: {
    name: "report",
    description:
      "Assemble a PR-ready markdown report from the app graph, verification, and budgets",
  },
  args: {
    base: {
      type: "string",
      description: "Base git ref to diff against (default: origin/main)",
    },
    out: {
      type: "string",
      description: "Write the report to a file instead of stdout",
    },
  },
  async run({ args }) {
    try {
      const markdown = await runReport(process.cwd(), {
        base: args.base || DEFAULT_BASE_REF,
        baseExplicit: Boolean(args.base),
      });

      if (args.out) {
        const outPath = resolve(process.cwd(), args.out);
        writeFileSync(outPath, ensureTrailingNewline(markdown), "utf-8");
        console.log(`Wrote ${args.out}.`);
        return;
      }

      console.log(markdown);
    } catch (error) {
      handleCliError(error, { json: false });
    }
  },
});
