import { defineCommand } from "citty";

import {
  diffGraphSnapshots,
  formatPlanMarkdown,
  formatPlanText,
  GRAPH_SNAPSHOT_PATH,
  readGraphSnapshotFromDisk,
  readGraphSnapshotFromRef,
  readRouteBudgets,
  resolveLiveGraph,
  serializeGraphSnapshot,
  writeGraphSnapshot,
  type GraphSnapshot,
  type RouteBudgetInfo,
} from "../graph-snapshot.js";
import { displayPath } from "../project.js";
import { handleCliError } from "../utils.js";

const EMPTY_GRAPH: GraphSnapshot = {
  prachtGraphVersion: 1,
  mode: "manifest",
  routes: [],
  api: [],
  constraints: [],
};

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
        base: args.base || "origin/main",
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
        console.error(
          `\nNote: no committed snapshot at ${JSON.stringify(report.baseRequested)} — run \`pracht plan --write\`, commit ${GRAPH_SNAPSHOT_PATH}, and future diffs become incremental.`,
        );
      }
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

export interface PlanReport {
  baseRequested: string;
  /** The base ref whose snapshot was found, or null when diffing from empty. */
  baseResolved: string | null;
  diff: ReturnType<typeof diffGraphSnapshots>;
  live: GraphSnapshot;
  snapshotPath: string;
  staleSnapshot: boolean;
  budgets: Record<string, RouteBudgetInfo>;
}

export async function runPlan(
  root: string,
  options: { base: string; write?: boolean },
): Promise<PlanReport> {
  const live = await resolveLiveGraph(root);

  if (options.write) {
    const snapshotPath = writeGraphSnapshot(root, live);
    return {
      baseRequested: options.base,
      baseResolved: null,
      diff: diffGraphSnapshots(live, live),
      live,
      snapshotPath: displayPath(root, snapshotPath),
      staleSnapshot: false,
      budgets: Object.fromEntries(readRouteBudgets(root)),
    };
  }

  const baseSnapshot = readGraphSnapshotFromRef(root, options.base);
  const diskSnapshot = readGraphSnapshotFromDisk(root);
  const staleSnapshot =
    diskSnapshot !== null && serializeGraphSnapshot(diskSnapshot) !== serializeGraphSnapshot(live);

  return {
    baseRequested: options.base,
    baseResolved: baseSnapshot ? options.base : null,
    diff: diffGraphSnapshots(baseSnapshot ?? EMPTY_GRAPH, live),
    live,
    snapshotPath: GRAPH_SNAPSHOT_PATH,
    staleSnapshot,
    budgets: Object.fromEntries(readRouteBudgets(root)),
  };
}
