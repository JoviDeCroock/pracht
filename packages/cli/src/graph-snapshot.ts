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
import type {
  BaseSnapshotResult,
  CapabilityChange,
  ChangedEntry,
  FieldChange,
  GraphDiff,
  GraphSnapshot,
} from "./graph-types.js";

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

const AGENT_TRANSPORTS = new Set(["mcp", "webmcp"]);

/**
 * Capability changes, classified by whether they widen the agent-reachable
 * surface. Registration, exposure, effect class, policy, middleware, and the
 * input schema all decide what an agent may do — and all of them are easy to
 * change without any visible route diff.
 */
export function diffCapabilities(
  base: readonly AppGraphCapability[],
  head: readonly AppGraphCapability[],
): CapabilityChange[] {
  const baseByName = new Map(base.map((entry) => [entry.name, entry]));
  const headByName = new Map(head.map((entry) => [entry.name, entry]));
  const changes: CapabilityChange[] = [];

  for (const entry of head) {
    if (baseByName.has(entry.name)) continue;
    const exposed = entry.transports.length > 0;
    changes.push({
      kind: "added",
      capability: entry.name,
      severity: exposed ? "warn" : "info",
      detail: exposed
        ? `new ${entry.effect ?? "?"} capability exposed via ${entry.transports.join(", ")}`
        : `new private ${entry.effect ?? "?"} capability`,
    });
  }

  for (const entry of base) {
    if (headByName.has(entry.name)) continue;
    changes.push({
      kind: "removed",
      capability: entry.name,
      severity: "info",
      detail: `removed (was ${entry.transports.join(", ") || "private"})`,
    });
  }

  for (const entry of head) {
    const previous = baseByName.get(entry.name);
    if (previous) changes.push(...diffCapability(previous, entry));
  }

  return changes.sort(
    (left, right) =>
      Number(right.severity === "warn") - Number(left.severity === "warn") ||
      left.capability.localeCompare(right.capability),
  );
}

function diffCapability(base: AppGraphCapability, head: AppGraphCapability): CapabilityChange[] {
  const changes: CapabilityChange[] = [];
  const capability = head.name;

  const addedTransports = head.transports.filter(
    (transport) => !base.transports.includes(transport),
  );
  const removedTransports = base.transports.filter(
    (transport) => !head.transports.includes(transport),
  );
  if (addedTransports.length > 0) {
    changes.push({
      kind: "exposure-added",
      capability,
      severity: "warn",
      detail: `now exposed via ${addedTransports.join(", ")}${
        addedTransports.some((transport) => AGENT_TRANSPORTS.has(transport))
          ? " — reachable by agents"
          : ""
      }`,
    });
  }
  if (removedTransports.length > 0) {
    changes.push({
      kind: "exposure-removed",
      capability,
      severity: "info",
      detail: `no longer exposed via ${removedTransports.join(", ")}`,
    });
  }

  if (base.effect !== head.effect) {
    changes.push({
      kind: "effect-changed",
      capability,
      // Reclassifying away from destructive silently drops the prepare/commit gate.
      severity: base.effect === "destructive" ? "warn" : "info",
      detail: `effect ${base.effect ?? "none"} → ${head.effect ?? "none"}`,
    });
  }

  // A capability whose contract could not be fully read serializes its guard
  // fields as blanks, so comparing two such entries finds "no change" even
  // when the policy and the middleware were both removed. Skip only those two
  // comparisons — everything else on this entry is statically recoverable and
  // still worth diffing — and annotate the result at the end, but only when
  // something else actually changed. Emitting it unconditionally would put a
  // "widens what agents can reach" banner on every PR for an app with one
  // such capability, which is alarm fatigue on the one signal that has to stay
  // credible.
  const guardsUnverified = Boolean(base.unverifiedContract || head.unverifiedContract);

  const basePolicy = base.agentPolicy ?? null;
  const headPolicy = head.agentPolicy ?? null;
  if (!guardsUnverified && basePolicy !== headPolicy) {
    const weakened = basePolicy === "require" && headPolicy !== "require";
    changes.push({
      kind: weakened ? "policy-weakened" : "policy-strengthened",
      capability,
      severity: weakened ? "warn" : "info",
      detail: `agentPolicy ${basePolicy ?? "(app default)"} → ${headPolicy ?? "(app default)"}`,
    });
  }

  const droppedMiddleware = base.middleware.filter((name) => !head.middleware.includes(name));
  const addedMiddleware = head.middleware.filter((name) => !base.middleware.includes(name));
  if (!guardsUnverified && droppedMiddleware.length > 0) {
    changes.push({
      kind: "middleware-removed",
      capability,
      severity: "warn",
      detail: `middleware removed: ${droppedMiddleware.join(", ")}`,
    });
  }
  if (!guardsUnverified && addedMiddleware.length > 0) {
    changes.push({
      kind: "middleware-added",
      capability,
      severity: "info",
      detail: `middleware added: ${addedMiddleware.join(", ")}`,
    });
  }

  if (base.httpPath && head.httpPath && base.httpPath !== head.httpPath) {
    changes.push({
      kind: "path-changed",
      capability,
      severity: "info",
      detail: `HTTP path ${base.httpPath} → ${head.httpPath}`,
    });
  }

  for (const detail of schemaWidenings(base.input, head.input)) {
    changes.push({ kind: "input-widened", capability, severity: "warn", detail });
  }

  if (JSON.stringify(base.output) !== JSON.stringify(head.output)) {
    changes.push({
      kind: "output-changed",
      capability,
      severity: "info",
      detail: "output schema changed — check what agents can now read",
    });
  }

  // Annotate a real diff; never stand alone. An unchanged unreadable
  // capability must produce no output, or every PR carries the banner.
  if (guardsUnverified && changes.length > 0) {
    changes.push({
      kind: "contract-unverified",
      capability,
      severity: "info",
      detail:
        "agentPolicy and middleware could not be read statically (the module does not load " +
        "outside its deploy runtime), so changes to them are not reflected above — review by hand",
    });
  }

  return changes;
}

/**
 * Structural widenings of an input schema. Accepting more than before is the
 * schema equivalent of loosening a guard, and it disappears into a line diff
 * as soon as a schema is more than a few lines long.
 */
function schemaWidenings(
  base: Record<string, unknown> | null,
  head: Record<string, unknown> | null,
  path = "",
): string[] {
  if (!base || !head) return [];
  const label = path || "input";
  const reasons: string[] = [];

  const noLongerRequired = stringArray(base.required).filter(
    (key) => !stringArray(head.required).includes(key),
  );
  if (noLongerRequired.length > 0) {
    reasons.push(`${label}: no longer requires ${noLongerRequired.join(", ")}`);
  }

  if (base.additionalProperties === false && head.additionalProperties !== false) {
    reasons.push(`${label}: additionalProperties opened up`);
  }

  const baseEnum = stringArray(base.enum);
  if (baseEnum.length > 0 && stringArray(head.enum).some((value) => !baseEnum.includes(value))) {
    reasons.push(`${label}: enum widened`);
  }

  for (const keyword of ["maximum", "maxLength"] as const) {
    const before = base[keyword];
    const after = head[keyword];
    if (
      typeof before === "number" &&
      (after === undefined || (typeof after === "number" && after > before))
    ) {
      reasons.push(`${label}: ${keyword} raised (${before} → ${after ?? "unbounded"})`);
    }
  }
  for (const keyword of ["minimum", "minLength"] as const) {
    const before = base[keyword];
    const after = head[keyword];
    if (
      typeof before === "number" &&
      (after === undefined || (typeof after === "number" && after < before))
    ) {
      reasons.push(`${label}: ${keyword} lowered (${before} → ${after ?? "unbounded"})`);
    }
  }

  const baseProperties = asRecord(base.properties);
  for (const [key, headSchema] of Object.entries(asRecord(head.properties))) {
    const baseSchema = baseProperties[key];
    if (baseSchema) {
      reasons.push(
        ...schemaWidenings(asRecord(baseSchema), asRecord(headSchema), `${label}.${key}`),
      );
    }
  }

  return reasons;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
