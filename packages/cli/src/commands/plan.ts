import { defineCommand } from "citty";

import { formatPlanMarkdown, formatPlanText, GRAPH_SNAPSHOT_PATH } from "../graph-snapshot.js";
import { DEFAULT_BASE_REF, describeMissingBase, runPlan } from "../plan.js";
import { handleCliError } from "../utils.js";

export default defineCommand({
  meta: {
    name: "plan",
    description: "Semantic app-graph diff against a base git ref",
  },
  args: {
    base: {
      type: "string",
      description: "Base git ref to diff against (default: origin/main)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
    markdown: {
      type: "boolean",
      description: "Output as markdown (for PR comments)",
    },
    write: {
      type: "boolean",
      description: `Write the current app graph to ${GRAPH_SNAPSHOT_PATH} and exit`,
    },
  },
  async run({ args }) {
    try {
      const report = await runPlan(process.cwd(), {
        base: args.base || DEFAULT_BASE_REF,
        baseExplicit: Boolean(args.base),
        write: Boolean(args.write),
      });

      if (args.write) {
        console.log(
          `Wrote ${report.snapshotPath}. Commit it so \`pracht plan\` can diff against it.`,
        );
        return;
      }

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      const format = args.markdown ? formatPlanMarkdown : formatPlanText;
      console.log(
        format(report.diff, {
          base: report.baseResolved,
          budgets: new Map(Object.entries(report.budgets)),
        }),
      );

      if (report.staleSnapshot) {
        console.error(
          `\nNote: ${GRAPH_SNAPSHOT_PATH} is stale — run \`pracht plan --write\` and commit the result.`,
        );
      }
      if (!report.baseResolved) {
        console.error(`\nNote: ${describeMissingBase(report)}`);
      }
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});
