/** Semantic app-graph comparison, including agent-surface widening classification. */

import { diffCapabilities } from "./graph-capability-diff.js";
import type { ChangedEntry, FieldChange, GraphDiff, GraphSnapshot } from "./graph-types.js";

const ROUTE_DIFF_FIELDS = [
  "render",
  "hydration",
  "shell",
  "middleware",
  "file",
  "loaderFile",
  "loaderCache",
  "markdown",
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

  const capabilityChanges = diffCapabilities(base.capabilities ?? [], head.capabilities ?? []);
  const baseMcpEndpoint = base.mcpEndpoint ?? null;
  const headMcpEndpoint = head.mcpEndpoint ?? null;
  const mcpEndpointChange =
    baseMcpEndpoint === headMcpEndpoint
      ? null
      : { field: "mcpEndpoint", from: baseMcpEndpoint, to: headMcpEndpoint };

  const identical =
    routeDiff.added.length === 0 &&
    routeDiff.removed.length === 0 &&
    routeDiff.changed.length === 0 &&
    apiDiff.added.length === 0 &&
    apiDiff.removed.length === 0 &&
    apiDiff.changed.length === 0 &&
    addedConstraints.length === 0 &&
    removedConstraints.length === 0 &&
    mcpEndpointChange === null &&
    capabilityChanges.length === 0;

  return {
    addedApi: apiDiff.added,
    addedConstraints,
    addedRoutes: routeDiff.added,
    capabilityChanges,
    changedApi: apiDiff.changed,
    changedRoutes: routeDiff.changed,
    identical,
    mcpEndpointChange,
    removedApi: apiDiff.removed,
    removedConstraints,
    removedRoutes: routeDiff.removed,
    widensAgentSurface:
      capabilityChanges.some((change) => change.severity === "warn") ||
      (baseMcpEndpoint === null && headMcpEndpoint !== null),
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
