import {
  applySchemaDefaults,
  collectUnsupportedSchemaKeywords,
  validateAgainstSchema,
  type JsonSchema,
  type SchemaIssue,
} from "./schema.ts";

/**
 * Side-effect classification. Every capability must declare one; the
 * framework's exposure policy is driven by it. `destructive` capabilities
 * may only be exposed over HTTP, where every dispatch is gated by the
 * server-verified prepare/commit confirmation flow (see docs/AGENT_TRUST.md);
 * agent projections (`webmcp`/`mcp`) stay disallowed for them in v1.
 */
export type CapabilityEffect = "read" | "write" | "destructive";

/**
 * Web Bot Auth policy for the capability's HTTP endpoint:
 * - `"observe"` — serve everyone, surface the verified identity on context;
 * - `"require"` — reject unsigned/unverified requests with a 401 envelope.
 * Unset inherits the app-wide default from `defineApp({ agents })`.
 */
export type CapabilityAgentPolicy = "observe" | "require";

export interface CapabilityHttpExposure {
  method: "POST";
  /** Custom dispatch path. Defaults to `/api/capabilities/<name-with-dots-as-slashes>`. */
  path?: string;
}

export interface CapabilityExposeConfig {
  /** Serve the capability over HTTP. `true` uses `POST` at the default path. */
  http?: true | { method?: "POST"; path?: string };
  /** Advertise the capability to the remote MCP projection (not built yet — recorded in the graph only). */
  mcp?: boolean;
  /** Register the capability as a WebMCP page tool. Requires `http` — calls dispatch through the HTTP projection. */
  webmcp?: boolean;
}

/** Normalized exposure — what the framework and graph consume. */
export interface CapabilityExposure {
  http: CapabilityHttpExposure | null;
  mcp: boolean;
  webmcp: boolean;
}

export interface CapabilityRunArgs<TInput = unknown, TContext = unknown> {
  input: TInput;
  context: TContext;
  request: Request;
  signal: AbortSignal;
}

export interface CapabilityDefinition<TInput = unknown, TOutput = unknown, TContext = unknown> {
  title: string;
  description: string;
  /** JSON Schema (supported subset) for the capability input. */
  input: JsonSchema;
  /** JSON Schema (supported subset) for the capability output. */
  output: JsonSchema;
  effect: CapabilityEffect;
  /** Named middleware from the app manifest, run before the handler. */
  middleware?: string[];
  /** Explicit exposure. A capability without `expose` is only callable server-side. */
  expose?: CapabilityExposeConfig;
  /** Per-capability Web Bot Auth policy override for the HTTP endpoint. */
  agentPolicy?: CapabilityAgentPolicy;
  run: (args: CapabilityRunArgs<TInput, TContext>) => TOutput | Promise<TOutput>;
}

export type CapabilityValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; issues: SchemaIssue[] };

/**
 * The object `defineCapability()` returns. The validation methods are
 * attached here so the framework runtime can execute capabilities through a
 * structural contract without depending on this package.
 */
export interface Capability<TInput = unknown, TOutput = unknown, TContext = unknown> {
  kind: "capability";
  title: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  effect: CapabilityEffect;
  middleware: string[];
  expose: CapabilityExposure | null;
  agentPolicy?: CapabilityAgentPolicy;
  run: (args: CapabilityRunArgs<TInput, TContext>) => TOutput | Promise<TOutput>;
  /** Apply input defaults and validate. Returns the defaulted value on success. */
  validateInput: (value: unknown) => CapabilityValidationResult<TInput>;
  validateOutput: (value: unknown) => CapabilityValidationResult<TOutput>;
}

/** Result/error envelope shared by HTTP, WebMCP, and direct server invocation. */
export type CapabilityEnvelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: CapabilityErrorPayload };

export interface CapabilityErrorPayload {
  code: string;
  message: string;
  issues?: SchemaIssue[];
  /** Present on `confirmation_required` errors: pass it back via `x-pracht-confirm`. */
  confirmationToken?: string;
  /** Unix seconds when `confirmationToken` expires. */
  expiresAt?: number;
}

export const DESTRUCTIVE_EXPOSURE_ERROR =
  "destructive capabilities cannot be exposed to agent projections (webmcp/mcp) yet — " +
  "only expose.http, where the prepare/commit confirmation flow gates every call";

/**
 * Define a protocol-neutral application capability.
 *
 * Fails fast (throws) on invalid definitions instead of deferring problems to
 * request time: missing contract fields, schemas outside the supported JSON
 * Schema subset, `webmcp` exposure without an HTTP projection to dispatch
 * through, and `webmcp`/`mcp` exposure of a `destructive` capability
 * (destructive + `expose.http` is allowed — the runtime's server-verified
 * prepare/commit confirmation flow gates every dispatch).
 */
export function defineCapability<TInput = unknown, TOutput = unknown, TContext = unknown>(
  definition: CapabilityDefinition<TInput, TOutput, TContext>,
): Capability<TInput, TOutput, TContext> {
  assertDefinition(definition);

  const expose = normalizeExposure(definition.expose);

  if (definition.effect === "destructive" && (expose?.webmcp || expose?.mcp)) {
    throw new Error(`defineCapability("${definition.title}"): ${DESTRUCTIVE_EXPOSURE_ERROR}.`);
  }
  if (expose?.webmcp && !expose.http) {
    throw new Error(
      `defineCapability("${definition.title}"): expose.webmcp requires expose.http — ` +
        "WebMCP page tools dispatch through the HTTP projection so all enforcement stays server-side.",
    );
  }

  return {
    kind: "capability",
    title: definition.title,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    effect: definition.effect,
    middleware: definition.middleware ?? [],
    expose,
    agentPolicy: definition.agentPolicy,
    run: definition.run,
    validateInput(value: unknown): CapabilityValidationResult<TInput> {
      const withDefaults = applySchemaDefaults(definition.input, value === undefined ? {} : value);
      const issues = validateAgainstSchema(definition.input, withDefaults);
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: withDefaults as TInput };
    },
    validateOutput(value: unknown): CapabilityValidationResult<TOutput> {
      const issues = validateAgainstSchema(definition.output, value);
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: value as TOutput };
    },
  };
}

function assertDefinition(definition: CapabilityDefinition<never, unknown, never>): void {
  const label = typeof definition?.title === "string" ? definition.title : "<untitled>";

  if (!definition || typeof definition !== "object") {
    throw new Error("defineCapability expects a definition object.");
  }
  for (const field of ["title", "description"] as const) {
    if (typeof definition[field] !== "string" || definition[field].trim() === "") {
      throw new Error(`defineCapability("${label}"): "${field}" must be a non-empty string.`);
    }
  }
  if (
    definition.effect !== "read" &&
    definition.effect !== "write" &&
    definition.effect !== "destructive"
  ) {
    throw new Error(
      `defineCapability("${label}"): "effect" must be "read", "write", or "destructive".`,
    );
  }
  if (typeof definition.run !== "function") {
    throw new Error(`defineCapability("${label}"): "run" must be a function.`);
  }

  for (const field of ["input", "output"] as const) {
    const schema = definition[field];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`defineCapability("${label}"): "${field}" must be a JSON Schema object.`);
    }
    const unsupported = collectUnsupportedSchemaKeywords(schema);
    if (unsupported.length > 0) {
      throw new Error(
        `defineCapability("${label}"): "${field}" schema uses unsupported JSON Schema keywords: ` +
          `${unsupported.join(", ")}. Supported keywords: type (object/array/string/number/` +
          "integer/boolean/null), properties, required, additionalProperties, items, enum, " +
          "const, minimum, maximum, minLength, maxLength, default, title, description.",
      );
    }
  }

  if (
    definition.middleware !== undefined &&
    (!Array.isArray(definition.middleware) ||
      definition.middleware.some((name) => typeof name !== "string"))
  ) {
    throw new Error(`defineCapability("${label}"): "middleware" must be an array of names.`);
  }

  if (
    definition.agentPolicy !== undefined &&
    definition.agentPolicy !== "observe" &&
    definition.agentPolicy !== "require"
  ) {
    throw new Error(`defineCapability("${label}"): "agentPolicy" must be "observe" or "require".`);
  }
}

function normalizeExposure(expose: CapabilityExposeConfig | undefined): CapabilityExposure | null {
  if (!expose) return null;

  let http: CapabilityHttpExposure | null = null;
  if (expose.http === true) {
    http = { method: "POST" };
  } else if (expose.http && typeof expose.http === "object") {
    if (expose.http.method !== undefined && expose.http.method !== "POST") {
      throw new Error('Capability HTTP exposure only supports method: "POST" for now.');
    }
    if (expose.http.path !== undefined) {
      if (typeof expose.http.path !== "string" || !expose.http.path.startsWith("/")) {
        throw new Error('Capability HTTP exposure "path" must be a string starting with "/".');
      }
      http = { method: "POST", path: expose.http.path };
    } else {
      http = { method: "POST" };
    }
  }

  const normalized: CapabilityExposure = {
    http,
    mcp: expose.mcp === true,
    webmcp: expose.webmcp === true,
  };

  if (!normalized.http && !normalized.mcp && !normalized.webmcp) return null;
  return normalized;
}
