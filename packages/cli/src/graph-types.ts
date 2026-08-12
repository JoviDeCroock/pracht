/** Shared contracts for app-graph snapshots, semantic diffs, and presentation. */

import type {
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphRoute,
  RouteConstraint,
} from "@pracht/core";

export interface GraphSnapshot {
  prachtGraphVersion: number;
  mode: "manifest" | "pages";
  routes: AppGraphRoute[];
  api: AppGraphApiRoute[];
  /**
   * Registered capabilities — the agent-facing half of the app's surface.
   * Snapshotting them lets reviewers see widened reach or weakened guards even
   * when an edit produces no visible route diff.
   */
  capabilities: AppGraphCapability[];
  /** Served remote MCP endpoint, or `null` when the projection is disabled. */
  mcpEndpoint: string | null;
  constraints: RouteConstraint[];
}

/**
 * Why a base snapshot could not be read. Keeping a missing ref distinct from
 * a missing snapshot prevents a typo'd `--base` from looking like a new app.
 */
export type BaseSnapshotStatus = "ok" | "missing-ref" | "no-snapshot" | "not-a-repo";

export interface BaseSnapshotResult {
  status: BaseSnapshotStatus;
  snapshot: GraphSnapshot | null;
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

/**
 * `warn` means the agent-reachable surface got wider or one of its guards got
 * weaker — the lines a reviewer must not scroll past.
 */
export type CapabilityChangeSeverity = "info" | "warn";

export interface CapabilityChange {
  kind:
    | "added"
    | "removed"
    | "exposure-added"
    | "exposure-removed"
    | "effect-changed"
    | "policy-weakened"
    | "policy-strengthened"
    | "middleware-removed"
    | "middleware-added"
    | "input-widened"
    | "output-changed"
    | "path-changed"
    | "contract-unverified";
  capability: string;
  severity: CapabilityChangeSeverity;
  detail: string;
}

export interface GraphDiff {
  addedApi: AppGraphApiRoute[];
  addedConstraints: RouteConstraint[];
  addedRoutes: AppGraphRoute[];
  capabilityChanges: CapabilityChange[];
  changedApi: ChangedEntry[];
  changedRoutes: ChangedEntry[];
  identical: boolean;
  mcpEndpointChange: FieldChange | null;
  removedApi: AppGraphApiRoute[];
  removedConstraints: RouteConstraint[];
  removedRoutes: AppGraphRoute[];
  /** True when any capability change is a widening — the headline for `report`. */
  widensAgentSurface: boolean;
}
