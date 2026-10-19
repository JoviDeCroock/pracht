/**
 * The capability descriptor: one normalized record of a capability's
 * contract, and the single place its authoring rules live.
 *
 * Every reader of a capability goes through here. `defineCapability()`
 * normalizes the definition it is handed (`source: "executed"`); the static
 * extractor, `pracht verify`, and the Vite plugin normalize the literal they
 * read from source (`source: "static"`); the app graph and the remote MCP
 * endpoint read a defined capability back with `describeCapability()`. Because
 * all of them produce the same record, `diffCapabilityDescriptors()` can
 * compare two readings key by key without a hand-maintained field list, and a
 * new field is checked the day it is added.
 *
 * Importable without executing anything: no module here runs user code.
 */

import type {
  Capability,
  CapabilityAgentPolicy,
  CapabilityEffect,
  CapabilityExposure,
} from "./capability.ts";
import { capabilityHttpPath, isValidCapabilityHttpPath } from "./protocol.ts";

/**
 * A capability's normalized contract.
 *
 * `undefined` in any position means "this reader could not determine it": a
 * value written as something other than an inline literal (static analysis),
 * or a fact the reader does not carry (the serialized app graph has no WebMCP
 * `untrustedContent`). `diffCapabilityDescriptors()` skips unknown values
 * rather than reporting them as drift. Every key is required, so a new field
 * fails to compile until every producer fills it in.
 */
export interface CapabilityDescriptor {
  title: string | undefined;
  description: string | undefined;
  effect: CapabilityEffect | undefined;
  /**
   * HTTP exposure. `path` is the resolved dispatch path when the capability
   * name is known, and `null` for "the default path" when it is not
   * (`defineCapability()` without a declared `name`).
   */
  http: { path: string | null } | null | undefined;
  /** Remote MCP exposure with its required OAuth scopes (`[]` when unscoped). */
  mcp: { scopes: readonly string[] } | null | undefined;
  /** WebMCP page-tool exposure with its `untrustedContentHint` annotation. */
  webmcp: { untrustedContent: boolean | undefined } | null | undefined;
  /** `null` inherits the app-wide Web Bot Auth policy. */
  agentPolicy: CapabilityAgentPolicy | null | undefined;
  middleware: readonly string[] | undefined;
}

/** The top-level definition key a problem is about. */
export type CapabilityDescriptorField = keyof CapabilityDescriptor | "expose";

export interface CapabilityDescriptorProblem {
  field: CapabilityDescriptorField;
  /** Reads after a label: `defineCapability("Search"): <message>.` */
  message: string;
}

export interface NormalizeCapabilityDescriptorContext {
  /** The registered name, when known — resolves the default HTTP path. */
  name?: string;
  /**
   * `"executed"`: `raw` is the object handed to `defineCapability()`.
   * `"static"`: `raw` is the literal read from source without executing it.
   */
  source: "executed" | "static";
  /**
   * Static only: top-level keys that are declared but could not be read as
   * literals. Their descriptor values are `undefined`, never a guess.
   */
  unreadable?: ReadonlySet<string>;
}

export const DESTRUCTIVE_EXPOSURE_ERROR =
  "destructive capabilities cannot be exposed to WebMCP page tools — a browser host's " +
  "approval UX is not a security boundary. Use expose.http, or expose.mcp with " +
  "agents.mcp.destructive, where the server-verified prepare/commit confirmation flow " +
  "gates every call";

export const WEBMCP_REQUIRES_HTTP_ERROR =
  "expose.webmcp requires expose.http — WebMCP page tools dispatch through the HTTP " +
  "projection so all enforcement stays server-side";

/**
 * RFC 6749 Appendix A.4 `scope-token`: printable ASCII except space, `"`, and
 * `\\`. The one validator for every OAuth scope pracht reads — capability
 * `expose.mcp.scopes` and the `agents.mcp.auth` scope lists alike.
 */
export function isValidOAuthScopeToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);
}

const EFFECTS: readonly string[] = ["read", "write", "destructive"];
const AGENT_POLICIES: readonly string[] = ["observe", "require"];
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Normalize a capability definition into its descriptor.
 *
 * Never throws. `defineCapability()` throws the first problem; `pracht verify`
 * reports every one; the build-time extractor fails on exposure problems. The
 * descriptor is best-effort when there are problems.
 */
export function normalizeCapabilityDescriptor(
  raw: unknown,
  context: NormalizeCapabilityDescriptorContext,
): { descriptor: CapabilityDescriptor; problems: CapabilityDescriptorProblem[] } {
  const problems: CapabilityDescriptorProblem[] = [];
  const definition: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const unreadable = context.source === "static" ? (context.unreadable ?? NO_KEYS) : NO_KEYS;
  const report = (field: CapabilityDescriptorField, message: string) =>
    problems.push({ field, message });

  const text = (field: "title" | "description"): string | undefined => {
    if (unreadable.has(field)) return undefined;
    const value = definition[field];
    if (typeof value === "string" && value.trim() !== "") return value;
    report(field, `"${field}" must be a non-empty string`);
    return undefined;
  };
  const title = text("title");
  const description = text("description");

  let effect: CapabilityEffect | undefined;
  if (!unreadable.has("effect")) {
    if (EFFECTS.includes(definition.effect as string)) {
      effect = definition.effect as CapabilityEffect;
    } else {
      report("effect", '"effect" must be "read", "write", or "destructive"');
    }
  }

  let middleware: readonly string[] | undefined;
  if (!unreadable.has("middleware")) {
    const value = definition.middleware;
    if (value === undefined) {
      middleware = [];
    } else if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
      middleware = [...value];
    } else {
      report("middleware", '"middleware" must be an array of names');
    }
  }

  let agentPolicy: CapabilityAgentPolicy | null | undefined;
  if (!unreadable.has("agentPolicy")) {
    const value = definition.agentPolicy;
    if (value === undefined) {
      agentPolicy = null;
    } else if (AGENT_POLICIES.includes(value as string)) {
      agentPolicy = value as CapabilityAgentPolicy;
    } else {
      report("agentPolicy", '"agentPolicy" must be "observe" or "require"');
    }
  }

  const exposure = unreadable.has("expose")
    ? { http: undefined, mcp: undefined, webmcp: undefined }
    : normalizeExpose(definition.expose, context, report);

  // Cross-field rules. Each needs both sides known: an unreadable effect or
  // exposure is the caller's to report, not a violation.
  if (effect === "destructive" && exposure.webmcp) {
    report("expose", DESTRUCTIVE_EXPOSURE_ERROR);
  }
  if (exposure.webmcp && exposure.http === null) {
    report("expose", WEBMCP_REQUIRES_HTTP_ERROR);
  }

  return {
    descriptor: { title, description, effect, ...exposure, agentPolicy, middleware },
    problems,
  };
}

function normalizeExpose(
  expose: unknown,
  context: NormalizeCapabilityDescriptorContext,
  report: (field: CapabilityDescriptorField, message: string) => void,
): Pick<CapabilityDescriptor, "http" | "mcp" | "webmcp"> {
  if (expose === undefined) return { http: null, mcp: null, webmcp: null };
  if (!isPlainObject(expose)) {
    report(
      "expose",
      context.source === "static"
        ? '"expose" must be an inline object literal so the client projection can be generated at build time'
        : '"expose" must be an object',
    );
    return { http: null, mcp: null, webmcp: null };
  }

  const defaultPath = context.name === undefined ? null : capabilityHttpPath(context.name);
  let http: { path: string | null } | null = null;
  if (expose.http === true) {
    http = { path: defaultPath };
  } else if (isPlainObject(expose.http)) {
    const { method, path } = expose.http;
    if (method !== undefined && method !== "POST") {
      report("expose", 'HTTP exposure only supports method: "POST"');
    }
    if (path !== undefined && !isValidCapabilityHttpPath(path)) {
      report(
        "expose",
        'HTTP exposure "path" must be an exact same-origin pathname starting with "/"',
      );
    }
    http = { path: typeof path === "string" ? path : defaultPath };
  } else if (expose.http !== undefined && expose.http !== false && expose.http !== null) {
    report("expose", '"expose.http" must be true or an object');
  }

  let webmcp: { untrustedContent: boolean } | null = null;
  if (expose.webmcp === true) {
    webmcp = { untrustedContent: false };
  } else if (isPlainObject(expose.webmcp)) {
    const { untrustedContent } = expose.webmcp;
    if (untrustedContent !== undefined && typeof untrustedContent !== "boolean") {
      report("expose", 'WebMCP exposure "untrustedContent" must be a boolean');
    }
    webmcp = { untrustedContent: untrustedContent === true };
  } else if (expose.webmcp !== undefined && expose.webmcp !== false && expose.webmcp !== null) {
    report("expose", '"expose.webmcp" must be a boolean or an options object');
  }

  // Anything other than `true` or an options object leaves MCP off, as it
  // always has: the projection fails closed on a value it does not recognize.
  let mcp: { scopes: readonly string[] } | null = null;
  if (expose.mcp === true) {
    mcp = { scopes: [] };
  } else if (isPlainObject(expose.mcp)) {
    const { scopes } = expose.mcp;
    if (scopes === undefined) {
      mcp = { scopes: [] };
    } else if (Array.isArray(scopes) && scopes.every(isValidOAuthScopeToken)) {
      mcp = { scopes: [...new Set<string>(scopes)] };
    } else {
      report(
        "expose",
        'MCP exposure "scopes" must be an array of OAuth scope tokens ' +
          "(printable ASCII without spaces, quotes, or backslashes)",
      );
      mcp = { scopes: [] };
    }
  }

  return { http, mcp, webmcp };
}

/**
 * The runtime exposure `defineCapability()` attaches, built from a descriptor
 * of the definition. `null` for a private capability.
 */
export function capabilityExposureFromDescriptor(
  descriptor: CapabilityDescriptor,
): CapabilityExposure | null {
  const { http, mcp, webmcp } = descriptor;
  if (!http && !mcp && !webmcp) return null;
  return {
    http: http
      ? http.path === null
        ? { method: "POST" }
        : { method: "POST", path: http.path }
      : null,
    mcp: !!mcp,
    ...(mcp && mcp.scopes.length > 0 ? { mcpScopes: Object.freeze([...mcp.scopes]) } : {}),
    webmcp: !!webmcp,
    webmcpUntrustedContent: webmcp?.untrustedContent === true,
  };
}

/**
 * Read a defined capability (a module's default export) back into its
 * descriptor, under its registered name. Reads exactly what the runtime
 * serves: HTTP and WebMCP when set, MCP only when `expose.mcp === true`.
 */
export function describeCapability(
  capability: Pick<
    Capability,
    "agentPolicy" | "description" | "effect" | "expose" | "middleware" | "title"
  >,
  name: string,
): CapabilityDescriptor {
  const expose = capability.expose;
  return {
    title: typeof capability.title === "string" ? capability.title : undefined,
    description: typeof capability.description === "string" ? capability.description : undefined,
    effect: EFFECTS.includes(capability.effect) ? capability.effect : undefined,
    http: expose?.http ? { path: expose.http.path ?? capabilityHttpPath(name) } : null,
    mcp: expose?.mcp === true ? { scopes: [...(expose.mcpScopes ?? [])] } : null,
    webmcp: expose?.webmcp ? { untrustedContent: expose.webmcpUntrustedContent === true } : null,
    agentPolicy: capability.agentPolicy ?? null,
    middleware: [...(capability.middleware ?? [])],
  };
}

/** The capability fields the serialized app graph carries. */
export interface CapabilityGraphFields {
  agentPolicy: string | null;
  description: string | null;
  effect: string | null;
  httpPath: string | null;
  middleware: string[];
  title: string | null;
  transports: string[];
  mcpScopes?: string[];
  unverifiedContract?: true;
}

/**
 * Project a descriptor into the app-graph fields. Unknown guard fields
 * (`agentPolicy`, `middleware`) set `unverifiedContract` rather than reading
 * as "none".
 */
export function capabilityGraphFields(descriptor: CapabilityDescriptor): CapabilityGraphFields {
  const transports: string[] = [];
  if (descriptor.http) transports.push("http");
  if (descriptor.mcp) transports.push("mcp");
  if (descriptor.webmcp) transports.push("webmcp");
  const unverified = descriptor.agentPolicy === undefined || descriptor.middleware === undefined;
  return {
    agentPolicy: descriptor.agentPolicy ?? null,
    description: descriptor.description ?? null,
    effect: descriptor.effect ?? null,
    httpPath: descriptor.http?.path ?? null,
    middleware: [...(descriptor.middleware ?? [])],
    title: descriptor.title ?? null,
    transports,
    ...(descriptor.mcp && descriptor.mcp.scopes.length > 0
      ? { mcpScopes: [...descriptor.mcp.scopes] }
      : {}),
    ...(unverified ? { unverifiedContract: true as const } : {}),
  };
}

/**
 * Read an app-graph capability entry back into a descriptor — the inverse of
 * `capabilityGraphFields()`. Fields the graph does not carry are unknown.
 */
export function capabilityDescriptorFromGraph(
  entry: Pick<CapabilityGraphFields, "effect" | "transports" | "mcpScopes"> &
    Partial<
      Pick<
        CapabilityGraphFields,
        "agentPolicy" | "description" | "httpPath" | "middleware" | "title" | "unverifiedContract"
      >
    >,
): CapabilityDescriptor {
  const unverified = entry.unverifiedContract === true;
  return {
    title: entry.title ?? undefined,
    description: entry.description ?? undefined,
    effect: EFFECTS.includes(entry.effect as string)
      ? (entry.effect as CapabilityEffect)
      : undefined,
    http:
      entry.httpPath === undefined
        ? undefined
        : entry.httpPath === null
          ? null
          : { path: entry.httpPath },
    mcp: entry.transports.includes("mcp") ? { scopes: [...(entry.mcpScopes ?? [])] } : null,
    webmcp: entry.transports.includes("webmcp") ? { untrustedContent: undefined } : null,
    agentPolicy: unverified ? undefined : (entry.agentPolicy as CapabilityAgentPolicy | null),
    middleware: unverified ? undefined : entry.middleware,
  };
}

interface DescriptorFieldSpec<T> {
  label: string;
  describe: (value: NonNullable<T> | null) => string;
}

const quote = (value: unknown): string => JSON.stringify(value);

/**
 * How each descriptor field reads in a drift message. Exhaustive by type: a
 * new descriptor key does not compile until it has an entry here.
 */
export const CAPABILITY_DESCRIPTOR_FIELDS = {
  title: { label: "title", describe: quote },
  description: { label: "description", describe: quote },
  effect: { label: "effect", describe: (value) => (value === null ? "none" : quote(value)) },
  http: {
    label: "HTTP endpoint",
    describe: (value) =>
      value === null ? "none" : value.path === null ? "the default path" : quote(value.path),
  },
  mcp: {
    label: "MCP exposure",
    describe: (value) =>
      value === null
        ? "off"
        : value.scopes.length > 0
          ? `on with scopes ${value.scopes.map(quote).join(", ")}`
          : "on without scopes",
  },
  webmcp: {
    label: "WebMCP exposure",
    describe: (value) =>
      value === null ? "off" : value.untrustedContent ? "on (untrustedContent)" : "on",
  },
  agentPolicy: {
    label: "agentPolicy",
    describe: (value) => (value === null ? "inherited" : quote(value)),
  },
  middleware: {
    label: "middleware",
    describe: (value) =>
      value === null || value.length === 0 ? "none" : `[${value.map(quote).join(", ")}]`,
  },
} satisfies { [K in keyof CapabilityDescriptor]-?: DescriptorFieldSpec<CapabilityDescriptor[K]> };

/**
 * Compare two readings of one capability, key by key — every key of either
 * descriptor, not a hand-picked list. A value one side could not determine
 * (`undefined`, at any depth) matches anything. Returns one sentence per
 * differing key: `<field> is <a> in <names.a> but <b> in <names.b>`.
 */
export function diffCapabilityDescriptors(
  a: CapabilityDescriptor,
  b: CapabilityDescriptor,
  names: { a: string; b: string } = { a: "the first reading", b: "the second reading" },
): string[] {
  const differences: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = (a as unknown as Record<string, unknown>)[key];
    const right = (b as unknown as Record<string, unknown>)[key];
    if (knownValuesAgree(left, right)) continue;
    // Fall back to the raw key so a field without a table entry (only possible
    // for a hand-built object) is still reported rather than skipped.
    const spec = (
      CAPABILITY_DESCRIPTOR_FIELDS as Record<
        string,
        { label: string; describe: (value: unknown) => string }
      >
    )[key] ?? { label: key, describe: quote };
    differences.push(
      `${spec.label} is ${spec.describe(left)} in ${names.a} but ${spec.describe(right)} in ${names.b}`,
    );
  }
  return differences;
}

function knownValuesAgree(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => knownValuesAgree(value, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!knownValuesAgree(left[key], right[key])) return false;
    }
    return true;
  }
  return Object.is(left, right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
