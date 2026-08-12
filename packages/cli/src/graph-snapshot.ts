import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  resolveMcpEndpoint,
  serializeApiRoutes,
  serializeAppRoutes,
  serializeCapabilities,
} from "@pracht/core";
import type { AppGraphCapability } from "@pracht/core";

import { capabilityModuleLoader, createSourceReader } from "./app-graph.js";
import { withAppServer } from "./app-server.js";
import type { BaseSnapshotResult, GraphSnapshot } from "./graph-types.js";

export { diffCapabilities, diffGraphSnapshots } from "./graph-diff.js";
export {
  formatPlanLines,
  formatPlanMarkdown,
  formatPlanText,
  readRouteBudgets,
  type FormatPlanOptions,
  type RouteBudgetInfo,
} from "./graph-plan-format.js";
export type {
  BaseSnapshotResult,
  BaseSnapshotStatus,
  CapabilityChange,
  CapabilityChangeSeverity,
  ChangedEntry,
  FieldChange,
  GraphDiff,
  GraphSnapshot,
} from "./graph-types.js";

/**
 * The app-graph snapshot is a committed, canonical serialization of the
 * resolved route graph (`.pracht/app-graph.json`) — a route-graph lockfile.
 * `pracht plan` diffs the live graph against the snapshot at a base git ref
 * to produce an intent-level changelog, and `pracht verify` fails when the
 * snapshot is stale, so the committed snapshot is always trustworthy.
 */

export const GRAPH_SNAPSHOT_PATH = ".pracht/app-graph.json";
export const GRAPH_SNAPSHOT_VERSION = 1;

export async function resolveLiveGraph(root: string): Promise<GraphSnapshot> {
  return withAppServer(root, async ({ project, server, serverModule }) => {
    const routes = serializeAppRoutes(serverModule.resolvedApp.routes);
    const api = await serializeApiRoutes(
      serverModule.apiRoutes,
      {
        loadModule: (file) => server.ssrLoadModule(file),
        readSource: (file) => readFileSync(resolve(root, `.${file}`), "utf-8"),
      },
      { strict: true },
    );
    const capabilities = await serializeCapabilities(
      serverModule.resolvedApp.capabilities,
      {
        loadModule: capabilityModuleLoader(server, serverModule),
        readSource: createSourceReader(root, project.appFile),
      },
      { strict: true },
    );

    return normalizeGraphSnapshot({
      prachtGraphVersion: GRAPH_SNAPSHOT_VERSION,
      mode: project.mode,
      routes,
      api,
      capabilities,
      mcpEndpoint: resolveMcpEndpoint(serverModule.resolvedApp.agents),
      constraints: serverModule.resolvedApp.constraints ?? [],
    });
  });
}

/**
 * Strip the diagnostic `error` field before a capability enters the committed
 * snapshot.
 *
 * The snapshot is compared byte-for-byte against `.pracht/app-graph.json` to
 * decide staleness, so serializing a new field would mark every committed
 * snapshot stale on upgrade with no real graph change. It also has no business
 * being committed: it is a local wiring failure, not app shape, and its message
 * carries absolute machine paths. It stays available on `pracht inspect
 * capabilities` and the dev banner, where it is actionable.
 */
function withoutLoadError(capability: AppGraphCapability): AppGraphCapability {
  if (capability.error == null) return capability;
  // `unverifiedContract` deliberately stays: it is the difference between "this
  // capability has no middleware" and "we could not read whether it does", and
  // a reviewer diffing the snapshot needs to see it. Only the machine-specific
  // error text is dropped.
  const { error: _error, ...rest } = capability;
  return rest;
}

/** Stable ordering + JSON round-trip so snapshots diff cleanly in git. */
export function normalizeGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const normalized: GraphSnapshot = {
    prachtGraphVersion: snapshot.prachtGraphVersion,
    mode: snapshot.mode,
    routes: [...snapshot.routes].sort((left, right) => left.path.localeCompare(right.path)),
    api: [...snapshot.api].sort((left, right) => left.path.localeCompare(right.path)),
    capabilities: [...(snapshot.capabilities ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    mcpEndpoint: snapshot.mcpEndpoint ?? null,
    constraints: snapshot.constraints ?? [],
  };
  return JSON.parse(JSON.stringify(normalized));
}

export function serializeGraphSnapshot(snapshot: GraphSnapshot): string {
  const normalized = normalizeGraphSnapshot(snapshot);
  return `${JSON.stringify(
    { ...normalized, capabilities: normalized.capabilities.map(withoutLoadError) },
    null,
    2,
  )}\n`;
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

/** Run a git read without leaking expected lookup failures to the terminal. */
function runGit(root: string, args: string[]): string | null {
  try {
    // stderr silenced: outside a git repo this prints `fatal: not a git
    // repository` straight to the user's terminal before the caller has a
    // chance to explain that a missing baseline is fine.
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Read the committed snapshot at a git ref, reporting *why* it is absent. */
export function resolveBaseSnapshot(root: string, ref: string): BaseSnapshotResult {
  const prefix = runGit(root, ["rev-parse", "--show-prefix"]);
  if (prefix === null) return { status: "not-a-repo", snapshot: null };

  // Verify the ref itself before asking for a path inside it, so "unknown ref"
  // and "ref exists but has no snapshot" stay distinguishable.
  if (runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) {
    return { status: "missing-ref", snapshot: null };
  }

  const contents = runGit(root, ["show", `${ref}:${prefix.trim()}${GRAPH_SNAPSHOT_PATH}`]);
  if (contents === null) return { status: "no-snapshot", snapshot: null };

  const snapshot = parseSnapshot(contents);
  return snapshot ? { status: "ok", snapshot } : { status: "no-snapshot", snapshot: null };
}

/** Read the committed snapshot at a git ref, or null when absent/unreadable. */
export function readGraphSnapshotFromRef(root: string, ref: string): GraphSnapshot | null {
  return resolveBaseSnapshot(root, ref).snapshot;
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
      // Snapshots committed before capabilities were tracked simply have none;
      // the first plan after upgrading reports them as added, and
      // `pracht plan --write` settles it.
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      // Snapshots committed before the remote MCP projection was served have
      // no endpoint field and therefore represent an unserved projection.
      mcpEndpoint: typeof parsed.mcpEndpoint === "string" ? parsed.mcpEndpoint : null,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
    };
  } catch {
    return null;
  }
}
