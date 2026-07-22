import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { serializeApiRoutes, serializeAppRoutes } from "@pracht/core";
import type { AppGraphApiRoute, AppGraphRoute, RouteConstraint } from "@pracht/core";

import { withAppServer } from "./app-server.js";
import { formatBytes } from "./bundle-report.js";

/**
 * The app-graph snapshot is a committed, canonical serialization of the
 * resolved route graph (`.pracht/app-graph.json`) — a route-graph lockfile.
 * `pracht plan` diffs the live graph against the snapshot at a base git ref
 * to produce an intent-level changelog, and `pracht verify` fails when the
 * snapshot is stale, so the committed snapshot is always trustworthy.
 */

export const GRAPH_SNAPSHOT_PATH = ".pracht/app-graph.json";
export const GRAPH_SNAPSHOT_VERSION = 1;

export interface GraphSnapshot {
  prachtGraphVersion: number;
  mode: "manifest" | "pages";
  routes: AppGraphRoute[];
  api: AppGraphApiRoute[];
  constraints: RouteConstraint[];
}

export async function resolveLiveGraph(root: string): Promise<GraphSnapshot> {
  return withAppServer(root, async ({ project, server, serverModule }) => {
    const routes = serializeAppRoutes(serverModule.resolvedApp.routes);
    const api = await serializeApiRoutes(serverModule.apiRoutes, {
      loadModule: (file) => server.ssrLoadModule(file),
      readSource: (file) => readFileSync(resolve(root, `.${file}`), "utf-8"),
    });

    return normalizeGraphSnapshot({
      prachtGraphVersion: GRAPH_SNAPSHOT_VERSION,
      mode: project.mode,
      routes,
      api,
      constraints: serverModule.resolvedApp.constraints ?? [],
    });
  });
}

/** Stable ordering + JSON round-trip so snapshots diff cleanly in git. */
export function normalizeGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const normalized: GraphSnapshot = {
    prachtGraphVersion: snapshot.prachtGraphVersion,
    mode: snapshot.mode,
    routes: [...snapshot.routes].sort((left, right) => left.path.localeCompare(right.path)),
    api: [...snapshot.api].sort((left, right) => left.path.localeCompare(right.path)),
    constraints: snapshot.constraints ?? [],
  };
  return JSON.parse(JSON.stringify(normalized));
}

export function serializeGraphSnapshot(snapshot: GraphSnapshot): string {
  return `${JSON.stringify(normalizeGraphSnapshot(snapshot), null, 2)}\n`;
}

export function writeGraphSnapshot(root: string, snapshot: GraphSnapshot): string {
  const filePath = resolve(root, GRAPH_SNAPSHOT_PATH);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeGraphSnapshot(snapshot), "utf-8");
  return filePath;
}

export function readGraphSnapshotFromDisk(root: string): GraphSnapshot | null {
  const filePath = resolve(root, GRAPH_SNAPSHOT_PATH);
  if (!existsSync(filePath)) return null;
  return parseSnapshot(readFileSync(filePath, "utf-8"));
}

/** Read the committed snapshot at a git ref, or null when absent/unreadable. */
export function readGraphSnapshotFromRef(root: string, ref: string): GraphSnapshot | null {
  try {
    const prefix = execFileSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
      encoding: "utf-8",
    }).trim();
    const contents = execFileSync(
      "git",
      ["-C", root, "show", `${ref}:${prefix}${GRAPH_SNAPSHOT_PATH}`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseSnapshot(contents);
  } catch {
    return null;
  }
}

function parseSnapshot(contents: string): GraphSnapshot | null {
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || !Array.isArray(parsed.routes) || !Array.isArray(parsed.api)) return null;
    return {
      prachtGraphVersion: parsed.prachtGraphVersion ?? GRAPH_SNAPSHOT_VERSION,
      mode: parsed.mode ?? "manifest",
      routes: parsed.routes,
      api: parsed.api,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
    };
  } catch {
    return null;
  }
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ChangedEntry {
  path: string;
  changes: FieldChange[];
}

export interface GraphDiff {
  addedApi: AppGraphApiRoute[];
  addedConstraints: RouteConstraint[];
  addedRoutes: AppGraphRoute[];
  changedApi: ChangedEntry[];
  changedRoutes: ChangedEntry[];
  identical: boolean;
  removedApi: AppGraphApiRoute[];
  removedConstraints: RouteConstraint[];
  removedRoutes: AppGraphRoute[];
}

const ROUTE_DIFF_FIELDS = [
  "render",
  "hydration",
  "shell",
  "middleware",
  "file",
  "loaderFile",
  "loaderCache",
  "revalidate",
  "id",
] as const;

export function diffGraphSnapshots(base: GraphSnapshot, head: GraphSnapshot): GraphDiff {
  const routeDiff = diffByPath(base.routes, head.routes, (left, right) =>
    collectFieldChanges(left, right, ROUTE_DIFF_FIELDS),
  );
  const apiDiff = diffByPath(base.api, head.api, (left, right) =>
    collectFieldChanges(left, right, ["methods", "file"] as const),
  );

  const baseConstraints = new Set(base.constraints.map((entry) => JSON.stringify(entry)));
  const headConstraints = new Set(head.constraints.map((entry) => JSON.stringify(entry)));
  const addedConstraints = head.constraints.filter(
    (entry) => !baseConstraints.has(JSON.stringify(entry)),
  );
  const removedConstraints = base.constraints.filter(
    (entry) => !headConstraints.has(JSON.stringify(entry)),
  );

  const identical =
    routeDiff.added.length === 0 &&
    routeDiff.removed.length === 0 &&
    routeDiff.changed.length === 0 &&
    apiDiff.added.length === 0 &&
    apiDiff.removed.length === 0 &&
    apiDiff.changed.length === 0 &&
    addedConstraints.length === 0 &&
    removedConstraints.length === 0;

  return {
    addedApi: apiDiff.added,
    addedConstraints,
    addedRoutes: routeDiff.added,
    changedApi: apiDiff.changed,
    changedRoutes: routeDiff.changed,
    identical,
    removedApi: apiDiff.removed,
    removedConstraints,
    removedRoutes: routeDiff.removed,
  };
}

function diffByPath<T extends { path: string }>(
  base: T[],
  head: T[],
  compare: (left: T, right: T) => FieldChange[],
): { added: T[]; changed: ChangedEntry[]; removed: T[] } {
  const baseByPath = new Map(base.map((entry) => [entry.path, entry]));
  const headByPath = new Map(head.map((entry) => [entry.path, entry]));

  const added = head.filter((entry) => !baseByPath.has(entry.path));
  const removed = base.filter((entry) => !headByPath.has(entry.path));
  const changed: ChangedEntry[] = [];

  for (const entry of head) {
    const baseEntry = baseByPath.get(entry.path);
    if (!baseEntry) continue;
    const changes = compare(baseEntry, entry);
    if (changes.length > 0) {
      changed.push({ path: entry.path, changes });
    }
  }

  return { added, changed, removed };
}

function collectFieldChanges<T>(
  base: T,
  head: T,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    const from = base[field] ?? null;
    const to = head[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}

export interface RouteBudgetInfo {
  gzipBytes: number;
  limitBytes: number;
  ok: boolean;
}

/** Per-route gzip sizes from the last `pracht build`, when budgets are configured. */
export function readRouteBudgets(root: string): Map<string, RouteBudgetInfo> {
  const budgets = new Map<string, RouteBudgetInfo>();
  const reportPath = resolve(root, "dist/server/budget-report.json");
  if (!existsSync(reportPath)) return budgets;

  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    for (const result of report.results ?? []) {
      budgets.set(result.path, {
        gzipBytes: result.gzipBytes,
        limitBytes: result.limitBytes,
        ok: result.ok,
      });
    }
  } catch {
    // A malformed report only disables size annotations.
  }
  return budgets;
}

export interface FormatPlanOptions {
  base: string | null;
  budgets?: Map<string, RouteBudgetInfo>;
}

export function formatPlanLines(diff: GraphDiff, options: FormatPlanOptions): string[] {
  const budgets = options.budgets ?? new Map();
  const lines: string[] = [];

  for (const route of diff.addedRoutes) {
    lines.push(
      `+ route ${route.path}  ${describeRoute(route)}${budgetSuffix(budgets, route.path)}`,
    );
  }
  for (const entry of diff.changedRoutes) {
    lines.push(
      `~ route ${entry.path}  ${entry.changes.map(formatFieldChange).join(", ")}${budgetSuffix(budgets, entry.path)}`,
    );
  }
  for (const route of diff.removedRoutes) {
    lines.push(`- route ${route.path}`);
  }
  for (const api of diff.addedApi) {
    lines.push(`+ api   ${api.path}  methods=[${api.methods.join(", ")}]`);
  }
  for (const entry of diff.changedApi) {
    lines.push(`~ api   ${entry.path}  ${entry.changes.map(formatFieldChange).join(", ")}`);
  }
  for (const api of diff.removedApi) {
    lines.push(`- api   ${api.path}`);
  }
  for (const constraint of diff.addedConstraints) {
    lines.push(`+ constraint ${describeConstraint(constraint)}`);
  }
  for (const constraint of diff.removedConstraints) {
    lines.push(`- constraint ${describeConstraint(constraint)}`);
  }

  return lines;
}

export function formatPlanText(diff: GraphDiff, options: FormatPlanOptions): string {
  const header = options.base
    ? `Pracht plan (base: ${options.base})`
    : "Pracht plan (no baseline snapshot — every entry shows as added)";
  const lines = formatPlanLines(diff, options);

  if (diff.identical) {
    return `${header}\n\nNo app graph changes.`;
  }
  return `${header}\n\n${lines.join("\n")}`;
}

export function formatPlanMarkdown(diff: GraphDiff, options: FormatPlanOptions): string {
  const heading = options.base
    ? `### App graph changes (base: \`${options.base}\`)`
    : "### App graph (no baseline snapshot at the base ref)";

  if (diff.identical) {
    return `${heading}\n\nNo app graph changes.`;
  }

  const lines = formatPlanLines(diff, options);
  const summary = [
    countLabel(diff.addedRoutes.length + diff.addedApi.length, "added"),
    countLabel(diff.changedRoutes.length + diff.changedApi.length, "changed"),
    countLabel(diff.removedRoutes.length + diff.removedApi.length, "removed"),
  ]
    .filter(Boolean)
    .join(", ");

  return [heading, "", summary ? `${summary}.` : "", "```diff", ...lines, "```"]
    .filter((line, index) => line !== "" || index === 1)
    .join("\n");
}

function describeRoute(route: AppGraphRoute): string {
  const parts = [`render=${route.render ?? "default"}`];
  if (route.hydration) parts.push(`hydration=${route.hydration}`);
  parts.push(`shell=${route.shell ?? "none"}`);
  parts.push(`middleware=[${route.middleware.join(", ")}]`);
  if (route.loaderFile) parts.push(`loader=${route.loaderFile}`);
  if (route.revalidate) parts.push(`revalidate=${JSON.stringify(route.revalidate)}`);
  return parts.join("  ");
}

function describeConstraint(constraint: RouteConstraint): string {
  const { kind, pattern, ...rest } = constraint as RouteConstraint & Record<string, unknown>;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return `${kind} ${pattern}${detail ? `  ${detail}` : ""}`;
}

function formatFieldChange(change: FieldChange): string {
  return `${change.field}: ${formatValue(change.from)} → ${formatValue(change.to)}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return `[${value.map((entry) => String(entry)).join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function budgetSuffix(budgets: Map<string, RouteBudgetInfo>, path: string): string {
  const budget = budgets.get(path);
  if (!budget) return "";
  const status = budget.ok ? "" : " ⚠ over budget";
  return `  (${formatBytes(budget.gzipBytes)} gz / ${formatBytes(budget.limitBytes)} limit${status})`;
}

function countLabel(count: number, label: string): string {
  return count > 0 ? `${count} ${label}` : "";
}
