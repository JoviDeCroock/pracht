import { defineCommand } from "citty";

import {
  diffGraphSnapshots,
  formatPlanMarkdown,
  formatPlanText,
  GRAPH_SNAPSHOT_PATH,
  readGraphSnapshotFromDisk,
  readRouteBudgets,
  resolveBaseSnapshot,
  resolveLiveGraph,
  serializeGraphSnapshot,
  writeGraphSnapshot,
  type BaseSnapshotStatus,
  type GraphSnapshot,
  type RouteBudgetInfo,
} from "../graph-snapshot.js";
import { displayPath } from "../project.js";
import { handleCliError } from "../utils.js";

export const DEFAULT_BASE_REF = "origin/main";

const EMPTY_GRAPH: GraphSnapshot = {
  prachtGraphVersion: 1,
  mode: "manifest",
  routes: [],
  api: [],
  capabilities: [],
  mcpEndpoint: null,
  mcpAuthenticated: false,
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

/** Explain a missing baseline in terms of what the user has to do next. */
export function describeMissingBase(report: {
  baseRequested: string;
  baseStatus?: BaseSnapshotStatus;
}): string {
  const ref = JSON.stringify(report.baseRequested);
  if (report.baseStatus === "not-a-repo") {
    return `not a git repository, so there is no ${ref} to diff against — every entry shows as added.`;
  }
  if (report.baseStatus === "missing-ref") {
    return `${ref} does not exist in this checkout, so every entry shows as added. Fetch that ref (CI checkouts are often shallow) or pass \`--base <ref>\`.`;
  }
  return `no committed snapshot at ${ref} — run \`pracht plan --write\`, commit ${GRAPH_SNAPSHOT_PATH}, and future diffs become incremental.`;
}

export interface PlanReport {
  baseRequested: string;
  /** The base ref whose snapshot was found, or null when diffing from empty. */
  baseResolved: string | null;
  /** Why the base snapshot is absent, when it is. */
  baseStatus?: BaseSnapshotStatus;
  diff: ReturnType<typeof diffGraphSnapshots>;
  live: GraphSnapshot;
  snapshotPath: string;
  staleSnapshot: boolean;
  budgets: Record<string, RouteBudgetInfo>;
}

export async function runPlan(
  root: string,
  options: { base: string; baseExplicit?: boolean; write?: boolean },
): Promise<PlanReport> {
  const live = await resolveLiveGraph(root);

  if (options.write) {
    const snapshotPath = writeGraphSnapshot(root, live);
    return {
      baseRequested: options.base,
      baseResolved: null,
      baseStatus: "ok",
      diff: diffGraphSnapshots(live, live),
      live,
      snapshotPath: displayPath(root, snapshotPath),
      staleSnapshot: false,
      budgets: Object.fromEntries(readRouteBudgets(root)),
    };
  }

  const base = resolveBaseSnapshot(root, options.base);
  // An *explicit* `--base` that does not resolve is a typo, and reporting every
  // route as added would be a lie the caller cannot see. The default is
  // different: `create-pracht` inits a repo with no remote, and
  // `actions/checkout` at its default depth creates no `origin/main` tracking
  // ref either — the standard PR CI shape, which is exactly where `report` is
  // meant to run. Degrade there the way a missing snapshot already does.
  if (base.status === "missing-ref" && options.baseExplicit) {
    throw new Error(
      `Base git ref ${JSON.stringify(options.base)} does not exist. ` +
        "Pass an existing ref with `--base <ref>` — for example the branch you are merging into.",
    );
  }

  const baseSnapshot = base.snapshot;
  const diskSnapshot = readGraphSnapshotFromDisk(root);
  const staleSnapshot =
    diskSnapshot !== null && serializeGraphSnapshot(diskSnapshot) !== serializeGraphSnapshot(live);

  return {
    baseRequested: options.base,
    baseResolved: baseSnapshot ? options.base : null,
    baseStatus: base.status,
    diff: diffGraphSnapshots(baseSnapshot ?? EMPTY_GRAPH, live),
    live,
    snapshotPath: GRAPH_SNAPSHOT_PATH,
    staleSnapshot,
    budgets: Object.fromEntries(readRouteBudgets(root)),
  };
}
