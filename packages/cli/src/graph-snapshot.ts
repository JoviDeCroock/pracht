import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  resolveMcpEndpoint,
  serializeApiRoutes,
  serializeAppRoutes,
  serializeCapabilities,
  servesDestructiveMcpTools,
} from "@pracht/core";
import type {
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphRoute,
  McpAuthConfig,
  ModuleRegistry,
  ResolvedRoute,
  RouteConstraint,
} from "@pracht/core";
import { loadMcpTokenVerifier } from "@pracht/core/server";

import { capabilityModuleLoader, createSourceReader } from "./app-graph.js";
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
export const GRAPH_SNAPSHOT_VERSION = 2;

export interface McpAuthSnapshot {
  authorizationServers: string[];
  requiredScopes: string[];
  resource: string;
  scopesSupported: string[];
  verify: string;
}

export interface GraphSnapshot {
  prachtGraphVersion: number;
  mode: "manifest" | "pages";
  routes: AppGraphRoute[];
  api: AppGraphApiRoute[];
  /**
   * Registered capabilities — the agent-facing half of the app's surface.
   * Snapshotting them is what lets `pracht plan` show a reviewer that a change
   * widened what agents can reach or weakened a guard; without it those edits
   * produce no signal at all.
   */
  capabilities: AppGraphCapability[];
  /** Served remote MCP endpoint, or `null` when the projection is disabled. */
  mcpEndpoint: string | null;
  /** Present only when `agents.mcp.destructive` serves destructive MCP tools. */
  mcpDestructive?: true;
  /** Whether the served remote MCP endpoint requires an OAuth bearer token. */
  mcpAuthenticated: boolean;
  /** Security-relevant OAuth policy; `null` when auth is disabled or from a legacy snapshot. */
  mcpAuth?: McpAuthSnapshot | null;
  constraints: RouteConstraint[];
}

export interface LiveGraphMetadata {
  graph: GraphSnapshot;
  /** Authoritative adapter capability from the resolved Vite configuration. */
  staticTarget: boolean;
  /** Routes whose generated loader hint says a server fetch may be required. */
  loaderRoutePaths: ReadonlySet<string>;
}

export async function resolveLiveGraphMetadata(root: string): Promise<LiveGraphMetadata> {
  return withAppServer(root, async ({ project, server, serverModule }) => {
    const resolvedRoutes = serverModule.resolvedApp.routes as ResolvedRoute[];
    await assertMcpTokenVerifierModule(serverModule);
    const routes = serializeAppRoutes(resolvedRoutes);
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

    return {
      graph: normalizeGraphSnapshot({
        prachtGraphVersion: GRAPH_SNAPSHOT_VERSION,
        mode: project.mode,
        routes,
        api,
        capabilities,
        mcpEndpoint: resolveMcpEndpoint(serverModule.resolvedApp.agents),
        ...(servesDestructiveMcpTools(serverModule.resolvedApp, capabilities)
          ? { mcpDestructive: true as const }
          : {}),
        mcpAuthenticated: !!serverModule.resolvedApp.agents?.mcp?.auth,
        mcpAuth: serializeMcpAuth(serverModule.resolvedApp.agents?.mcp?.auth),
        constraints: serverModule.resolvedApp.constraints ?? [],
      }),
      loaderRoutePaths: new Set(
        resolvedRoutes
          .filter((route) => route.loaderFile !== undefined || route.hasLoader !== false)
          .map((route) => route.path),
      ),
      staticTarget: serverModule.staticTarget === true,
    };
  });
}

async function assertMcpTokenVerifierModule(serverModule: Record<string, any>): Promise<void> {
  const auth = serverModule.resolvedApp.agents?.mcp?.auth as McpAuthConfig | undefined;
  if (!auth) return;
  await loadMcpTokenVerifier(auth, serverModule.registry as ModuleRegistry);
}

export async function resolveLiveGraph(root: string): Promise<GraphSnapshot> {
  return (await resolveLiveGraphMetadata(root)).graph;
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
    ...(snapshot.mcpDestructive === true ? { mcpDestructive: true } : {}),
    mcpAuthenticated: snapshot.mcpAuthenticated ?? false,
    mcpAuth: snapshot.mcpAuth ?? null,
    constraints: snapshot.constraints ?? [],
  };
  return JSON.parse(JSON.stringify(normalized));
}

export function serializeMcpAuth(auth: McpAuthConfig | undefined): McpAuthSnapshot | null {
  if (!auth || typeof auth.verify !== "string") return null;
  return {
    authorizationServers: [...auth.authorizationServers],
    requiredScopes: [...(auth.requiredScopes ?? [])],
    resource: auth.resource,
    scopesSupported: [...(auth.scopesSupported ?? [])],
    verify: auth.verify,
  };
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

/**
 * Why a base snapshot could not be read.
 *
 * `missing-ref` is deliberately distinct from `no-snapshot`: a typo'd
 * `--base`, or the very common "fresh repo with no `origin/main`" case, used
 * to be indistinguishable from a genuinely new app, so `pracht plan` reported
 * every route as added and exited 0 — exactly the situation where a reviewer
 * would trust the diff.
 */
export type BaseSnapshotStatus = "ok" | "missing-ref" | "no-snapshot" | "not-a-repo";

export interface BaseSnapshotResult {
  status: BaseSnapshotStatus;
  snapshot: GraphSnapshot | null;
}

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
      // Omit the false/default form so snapshots from before the destructive
      // MCP opt-in remain byte-identical until an app actually enables it.
      ...(parsed.mcpDestructive === true ? { mcpDestructive: true } : {}),
      // Older snapshots predate OAuth protection and therefore describe an
      // endpoint whose authentication remained application middleware's job.
      mcpAuthenticated: parsed.mcpAuthenticated === true,
      mcpAuth: parseMcpAuthSnapshot(parsed.mcpAuth),
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
    };
  } catch {
    return null;
  }
}

function parseMcpAuthSnapshot(value: unknown): McpAuthSnapshot | null {
  const record = asRecord(value);
  if (
    typeof record.resource !== "string" ||
    typeof record.verify !== "string" ||
    !Array.isArray(record.authorizationServers) ||
    !record.authorizationServers.every((entry) => typeof entry === "string") ||
    !Array.isArray(record.requiredScopes) ||
    !record.requiredScopes.every((entry) => typeof entry === "string") ||
    !Array.isArray(record.scopesSupported) ||
    !record.scopesSupported.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return {
    authorizationServers: record.authorizationServers as string[],
    requiredScopes: record.requiredScopes as string[],
    resource: record.resource,
    scopesSupported: record.scopesSupported as string[],
    verify: record.verify,
  };
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
  mcpDestructiveChange: FieldChange | null;
  mcpAuthenticationChange: FieldChange | null;
  mcpAuthChanges: FieldChange[];
  mcpEndpointChange: FieldChange | null;
  removedApi: AppGraphApiRoute[];
  removedConstraints: RouteConstraint[];
  removedRoutes: AppGraphRoute[];
  /** True when any capability change is a widening — the headline for `report`. */
  widensAgentSurface: boolean;
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
  const baseMcpDestructive = base.mcpDestructive === true;
  const headMcpDestructive = head.mcpDestructive === true;
  const mcpDestructiveChange =
    baseMcpDestructive === headMcpDestructive
      ? null
      : {
          field: "mcpDestructive",
          from: baseMcpDestructive,
          to: headMcpDestructive,
        };
  const baseMcpAuthenticated = base.mcpAuthenticated ?? false;
  const headMcpAuthenticated = head.mcpAuthenticated ?? false;
  // Disabling the endpoint already describes the complete contraction; its
  // now-irrelevant auth flag does not need a second line in the plan.
  const mcpAuthenticationChange =
    headMcpEndpoint !== null && baseMcpAuthenticated !== headMcpAuthenticated
      ? {
          field: "mcpAuthenticated",
          from: baseMcpAuthenticated,
          to: headMcpAuthenticated,
        }
      : null;
  const mcpAuthChanges =
    baseMcpAuthenticated &&
    headMcpAuthenticated &&
    base.mcpAuth !== null &&
    base.mcpAuth !== undefined &&
    head.mcpAuth !== null &&
    head.mcpAuth !== undefined
      ? collectFieldChanges(base.mcpAuth, head.mcpAuth, [
          "resource",
          "authorizationServers",
          "requiredScopes",
          "scopesSupported",
          "verify",
        ] as const)
      : [];

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
    mcpDestructiveChange === null &&
    mcpAuthenticationChange === null &&
    mcpAuthChanges.length === 0 &&
    capabilityChanges.length === 0;

  return {
    addedApi: apiDiff.added,
    addedConstraints,
    addedRoutes: routeDiff.added,
    capabilityChanges,
    changedApi: apiDiff.changed,
    changedRoutes: routeDiff.changed,
    identical,
    mcpDestructiveChange,
    mcpAuthenticationChange,
    mcpAuthChanges,
    mcpEndpointChange,
    removedApi: apiDiff.removed,
    removedConstraints,
    removedRoutes: routeDiff.removed,
    widensAgentSurface:
      capabilityChanges.some((change) => change.severity === "warn") ||
      (baseMcpEndpoint === null && headMcpEndpoint !== null) ||
      (!baseMcpDestructive && headMcpDestructive) ||
      (baseMcpAuthenticated && !headMcpAuthenticated && headMcpEndpoint !== null) ||
      mcpAuthChanges.some(mcpAuthChangeWeakensGuard),
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

function mcpAuthChangeWeakensGuard(change: FieldChange): boolean {
  const before = stringArray(change.from);
  const after = stringArray(change.to);
  if (change.field === "requiredScopes") {
    return before.some((scope) => !after.includes(scope));
  }
  if (change.field === "authorizationServers") {
    return after.some((issuer) => !before.includes(issuer));
  }
  return false;
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
  if (diff.mcpEndpointChange) {
    lines.push(formatMcpEndpointChange(diff.mcpEndpointChange));
  }
  if (diff.mcpDestructiveChange) {
    lines.push(formatMcpDestructiveChange(diff.mcpDestructiveChange));
  }
  if (diff.mcpAuthenticationChange) {
    lines.push(formatMcpAuthenticationChange(diff.mcpAuthenticationChange));
  }
  for (const change of diff.mcpAuthChanges) {
    lines.push(
      `${mcpAuthChangeWeakensGuard(change) ? "!" : "~"} mcp oauth ${formatFieldChange(change)}`,
    );
  }
  for (const change of diff.capabilityChanges) {
    lines.push(
      `${capabilityChangeMarker(change)} capability ${change.capability}  ${change.detail}`,
    );
  }
  for (const constraint of diff.addedConstraints) {
    lines.push(`+ constraint ${describeConstraint(constraint)}`);
  }
  for (const constraint of diff.removedConstraints) {
    lines.push(`- constraint ${describeConstraint(constraint)}`);
  }

  return lines;
}

/**
 * Diff-block prefix. `!` marks a widening so it reads as a warning in the
 * rendered diff rather than blending into ordinary additions.
 */
function capabilityChangeMarker(change: CapabilityChange): string {
  if (change.severity === "warn") return "!";
  if (change.kind === "added") return "+";
  if (change.kind === "removed") return "-";
  return "~";
}

function formatMcpEndpointChange(change: FieldChange): string {
  const from = typeof change.from === "string" ? change.from : null;
  const to = typeof change.to === "string" ? change.to : null;
  if (!from && to) {
    return `! mcp endpoint ${to} enabled — declared MCP capabilities are now reachable by agents`;
  }
  if (from && !to) return `- mcp endpoint ${from} disabled`;
  return `~ mcp endpoint ${from} → ${to}`;
}

function formatMcpDestructiveChange(change: FieldChange): string {
  return change.to === true
    ? "! mcp destructive tools enabled — declared destructive MCP capabilities are now reachable by agents"
    : "- mcp destructive tools disabled";
}

function formatMcpAuthenticationChange(change: FieldChange): string {
  return change.to === true
    ? "+ mcp oauth protection enabled"
    : "! mcp oauth protection disabled — remote MCP endpoint no longer requires bearer tokens";
}

export function formatPlanText(diff: GraphDiff, options: FormatPlanOptions): string {
  const header = options.base
    ? `Pracht plan (base: ${options.base})`
    : "Pracht plan (no baseline snapshot — every entry shows as added)";
  const lines = formatPlanLines(diff, options);

  if (diff.identical) {
    return `${header}\n\nNo app graph changes.`;
  }
  const footer = diff.widensAgentSurface
    ? "\n\nThis change widens what agents can reach or weakens a guard (! lines)."
    : "";
  return `${header}\n\n${lines.join("\n")}${footer}`;
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
    countLabel(diff.mcpEndpointChange ? 1 : 0, "MCP endpoint change"),
    countLabel(diff.mcpDestructiveChange ? 1 : 0, "MCP destructive-mode change"),
    countLabel(diff.mcpAuthenticationChange ? 1 : 0, "MCP authentication change"),
    countLabel(diff.mcpAuthChanges.length, "MCP OAuth policy change"),
    countLabel(diff.capabilityChanges.length, "capability change"),
  ]
    .filter(Boolean)
    .join(", ");
  // The one thing in a plan that is a security decision rather than a
  // structural one, so it goes above the diff instead of inside it.
  const warning = diff.widensAgentSurface
    ? "> ⚠️ **This change widens what agents can reach or weakens a guard.**"
    : "";

  return [heading, "", summary ? `${summary}.` : "", warning, "```diff", ...lines, "```"]
    .filter((line, index) => line !== "" || index === 1)
    .join("\n");
}

function describeRoute(route: AppGraphRoute): string {
  const parts = [`render=${route.render ?? "default"}`];
  if (route.hydration) parts.push(`hydration=${route.hydration}`);
  parts.push(`shell=${route.shell ?? "none"}`);
  parts.push(`middleware=[${route.middleware.join(", ")}]`);
  if (route.markdown) parts.push("markdown=true");
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
