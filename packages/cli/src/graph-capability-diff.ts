/** Trust-sensitive capability and input-schema graph comparison. */

import type { AppGraphCapability } from "@pracht/core";

import type { CapabilityChange } from "./graph-types.js";

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
