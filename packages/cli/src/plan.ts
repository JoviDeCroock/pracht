import {
  diffGraphSnapshots,
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
} from "./graph-snapshot.js";
import { displayPath } from "./project.js";

export const DEFAULT_BASE_REF = "origin/main";

const EMPTY_GRAPH: GraphSnapshot = {
  prachtGraphVersion: 1,
  mode: "manifest",
  routes: [],
  api: [],
  capabilities: [],
  mcpEndpoint: null,
  constraints: [],
};

export interface PlanOptions {
  base: string;
  baseExplicit?: boolean;
  write?: boolean;
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

export async function runPlan(root: string, options: PlanOptions): Promise<PlanReport> {
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
