import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

import {
  isValidCapabilityHttpPath,
  isValidCapabilityName,
  type CapabilityErrorCode,
  type PrachtAgentIdentity,
} from "./protocol.ts";
import {
  applySchemaDefaults,
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
  validateAgainstSchema,
  type JsonSchema,
  type CapabilityIssue,
} from "./schema.ts";

/**
 * Side-effect classification. Every capability must declare one; the
 * framework's exposure policy is driven by it. `destructive` capabilities may
 * be exposed over HTTP and over remote MCP, where every dispatch is gated by
 * the server-verified prepare/commit confirmation flow (see
 * docs/AGENT_TRUST.md) — MCP additionally requires the `agents.mcp.destructive`
 * opt-in. WebMCP page tools stay disallowed for them: a browser host's
 * approval UX is not a security boundary.
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
  /**
   * Advertise the capability to the configured remote MCP projection. A
   * `destructive` capability is only served when the app also sets
   * `agents.mcp.destructive`; otherwise the projection filters it out.
   */
  mcp?: boolean;
  /**
   * Register the capability as a WebMCP page tool. Requires `http` — calls
   * dispatch through the HTTP projection. The object form sets
   * `untrustedContent: true` to advertise the spec's `untrustedContentHint`
   * annotation for tools whose results carry user-generated or third-party
   * content the host should treat as untrusted.
   */
  webmcp?: boolean | CapabilityWebmcpOptions;
}

export interface CapabilityWebmcpOptions {
  /** Advertise `untrustedContentHint` — results may carry user-generated or third-party content. */
  untrustedContent?: boolean;
}

/** Normalized exposure — what the framework and graph consume. */
export interface CapabilityExposure {
  http: CapabilityHttpExposure | null;
  mcp: boolean;
  webmcp: boolean;
  /** The WebMCP tool's `untrustedContentHint` annotation. Always `false` when `webmcp` is `false`. */
  webmcpUntrustedContent: boolean;
}

/**
 * The request context a capability handler receives by default: the verified
 * agent identity the framework surfaces on every request, plus whatever app
 * middleware attached. Narrow the open part with your own context type via
 * the third `defineCapability` generic.
 */
export interface CapabilityContext {
  /** Verified agent identity (Web Bot Auth); `null` when unsigned/unverified, absent when the app does not configure agents. */
  readonly agent?: PrachtAgentIdentity | null;
  [key: string]: unknown;
}

export interface CapabilityRunArgs<TInput = unknown, TContext = CapabilityContext> {
  input: TInput;
  context: TContext;
  request: Request;
  signal: AbortSignal;
}

export interface CapabilityDefinition<
  TInput = unknown,
  TOutput = unknown,
  TContext = CapabilityContext,
> {
  /**
   * The registered capability name (`"notes.search"`).
   *
   * Manifest apps take the name from the `capabilities` registry key and leave
   * this unset. Pages-router apps have no registry, so the module declares its
   * own name here; without it the name is the file stem
   * (`capabilities/notes-search.ts` → `notes-search`). The declared name must
   * match its file stem with dots written as hyphens — the same mapping
   * `pracht generate capability` uses — so the file a name resolves to stays
   * readable from the name alone.
   */
  name?: string;
  title: string;
  description: string;
  /** JSON Schema (supported subset), or a Standard JSON Schema, for the capability input. */
  input: JsonSchema | StandardJSONSchemaV1<unknown, TInput>;
  /** JSON Schema (supported subset), or a Standard JSON Schema, for the capability output. */
  output: JsonSchema | StandardJSONSchemaV1<unknown, TOutput>;
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
  | { ok: false; issues: CapabilityIssue[] };

export type CapabilityValidation<T = unknown> =
  | CapabilityValidationResult<T>
  | Promise<CapabilityValidationResult<T>>;

/**
 * The object `defineCapability()` returns. The validation methods are
 * attached here so the framework runtime can execute capabilities through a
 * structural contract without depending on this package.
 */
export interface Capability<TInput = unknown, TOutput = unknown, TContext = CapabilityContext> {
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
  validateInput: (value: unknown) => CapabilityValidation<TInput>;
  validateOutput: (value: unknown) => CapabilityValidation<TOutput>;
}

/** Result/error envelope shared by HTTP, WebMCP, and direct server invocation. */
export type CapabilityEnvelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: CapabilityErrorPayload };

export interface CapabilityErrorPayload {
  code: CapabilityErrorCode;
  message: string;
  issues?: CapabilityIssue[];
  /** Present on `confirmation_required` errors: pass it back via the CONFIRMATION_HEADER. */
  confirmationToken?: string;
  /** Unix seconds when `confirmationToken` expires. */
  expiresAt?: number;
  /**
   * Present on `confirmation_required`/`confirmation_pending` when an approval
   * store is registered: the proposal's id, for correlating with a review
   * surface. Derived server-side from the principal, capability, and input —
   * never accepted from a caller.
   */
  approvalId?: string;
  /**
   * Present when a decided proposal is blocking a re-prepare of the identical
   * operation: seconds until it expires and the operation can be proposed
   * again. The refusal is deliberate — it stops an old still-valid token
   * becoming reusable — so this says when to come back rather than inviting an
   * immediate retry.
   */
  retryAfterSeconds?: number;
}

export const DESTRUCTIVE_EXPOSURE_ERROR =
  "destructive capabilities cannot be exposed to WebMCP page tools — a browser host's " +
  "approval UX is not a security boundary. Use expose.http, or expose.mcp with " +
  "agents.mcp.destructive, where the server-verified prepare/commit confirmation flow " +
  "gates every call";

export const MCP_SCHEMA_ROOT_ERROR =
  'expose.mcp requires "input" and "output" schemas with type: "object" for the supported MCP protocol versions';

/**
 * Define a protocol-neutral application capability.
 *
 * Fails fast (throws) on invalid definitions instead of deferring problems to
 * request time: missing contract fields, schemas outside the supported JSON
 * Schema subset, `webmcp` exposure without an HTTP projection to dispatch
 * through, and `webmcp` exposure of a `destructive` capability.
 *
 * `destructive` + `expose.http` and `destructive` + `expose.mcp` are both
 * allowed — the runtime's server-verified prepare/commit confirmation flow
 * gates every dispatch on either transport. Serving destructive tools over
 * remote MCP additionally requires the app-level `agents.mcp.destructive`
 * opt-in and a registered approval store; without the opt-in the projection
 * filters them out at serve time.
 */
export function defineCapability<TInput = unknown, TOutput = unknown, TContext = CapabilityContext>(
  definition: CapabilityDefinition<TInput, TOutput, TContext>,
): Capability<TInput, TOutput, TContext> {
  const schemas = resolveDefinitionSchemas(definition);
  const inputValidator = standardSchemaValidator(definition.input);
  const outputValidator = standardSchemaValidator(definition.output);
  const resolvedDefinition = {
    ...definition,
    input: schemas.input,
    output: schemas.output,
  };
  assertDefinition(resolvedDefinition);

  const expose = normalizeExposure(definition.expose);

  if (definition.effect === "destructive" && expose?.webmcp) {
    throw new Error(`defineCapability("${definition.title}"): ${DESTRUCTIVE_EXPOSURE_ERROR}.`);
  }
  if (expose?.webmcp && !expose.http) {
    throw new Error(
      `defineCapability("${definition.title}"): expose.webmcp requires expose.http — ` +
        "WebMCP page tools dispatch through the HTTP projection so all enforcement stays server-side.",
    );
  }
  if (expose?.mcp && (schemas.input.type !== "object" || schemas.output.type !== "object")) {
    throw new Error(`defineCapability("${definition.title}"): ${MCP_SCHEMA_ROOT_ERROR}.`);
  }

  return {
    kind: "capability",
    title: definition.title,
    description: definition.description,
    input: schemas.input,
    output: schemas.output,
    effect: definition.effect,
    middleware: definition.middleware ?? [],
    expose,
    agentPolicy: definition.agentPolicy,
    run: definition.run,
    validateInput(value: unknown): CapabilityValidation<TInput> {
      const withDefaults = applySchemaDefaults(schemas.input, value === undefined ? {} : value);
      if (inputValidator) return validateWithStandardSchema(inputValidator, withDefaults);
      const issues = validateAgainstSchema(schemas.input, withDefaults);
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: withDefaults as TInput };
    },
    validateOutput(value: unknown): CapabilityValidation<TOutput> {
      if (outputValidator) return validateWithStandardSchema(outputValidator, value);
      const issues = validateAgainstSchema(schemas.output, value);
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: value as TOutput };
    },
  };
}

function standardSchemaValidator(
  schema: JsonSchema | StandardJSONSchemaV1,
): StandardSchemaV1["~standard"]["validate"] | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const standard = (schema as { "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object" || Array.isArray(standard)) return null;
  const validate = (standard as { validate?: unknown }).validate;
  return typeof validate === "function"
    ? (validate.bind(standard) as StandardSchemaV1["~standard"]["validate"])
    : null;
}

async function validateWithStandardSchema<T>(
  validate: StandardSchemaV1["~standard"]["validate"],
  value: unknown,
): Promise<CapabilityValidationResult<T>> {
  const result = await validate(value);
  if (!result.issues) {
    // A Standard Schema may transform JSON input into a JavaScript-only value
    // (Date, bigint, class instance, undefined). Capability boundaries remain
    // JSON-only regardless of the validator, so keep the invariant after the
    // transform as well as on the advertised wire schema.
    const jsonIssues = validateAgainstSchema({}, result.value);
    if (jsonIssues.length > 0) return { ok: false, issues: jsonIssues };
    return { ok: true, value: result.value as T };
  }
  return {
    ok: false,
    issues: result.issues.map((issue) => ({
      path: standardIssuePath(issue.path),
      message: issue.message,
    })),
  };
}

function standardIssuePath(path: StandardSchemaV1.Issue["path"]): string {
  if (!path) return "";
  return path
    .map((segment) => (typeof segment === "object" && segment !== null ? segment.key : segment))
    .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
    .map((segment) => `/${segment}`)
    .join("");
}

function resolveDefinitionSchemas<TInput, TOutput, TContext>(
  definition: CapabilityDefinition<TInput, TOutput, TContext>,
): { input: JsonSchema; output: JsonSchema } {
  const label = typeof definition?.title === "string" ? definition.title : "<untitled>";
  return {
    input: resolveDefinitionSchema(definition?.input, "input", "input", label),
    output: resolveDefinitionSchema(definition?.output, "output", "output", label),
  };
}

function resolveDefinitionSchema(
  schema: JsonSchema | StandardJSONSchemaV1 | undefined,
  field: "input" | "output",
  direction: "input" | "output",
  label: string,
): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema as JsonSchema;
  }

  const standard = (schema as { "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object" || Array.isArray(standard)) {
    return schema as JsonSchema;
  }
  const jsonSchema = (standard as { jsonSchema?: unknown }).jsonSchema;
  if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
    throw new Error(
      `defineCapability("${label}"): "${field}" implements Standard Schema but not Standard JSON Schema. ` +
        "Use a validator with Standard JSON Schema support or pass a plain JSON Schema object.",
    );
  }
  const convert = (jsonSchema as Record<string, unknown>)[direction];
  if (typeof convert !== "function") {
    throw new Error(
      `defineCapability("${label}"): "${field}" Standard JSON Schema is missing its ${direction} converter.`,
    );
  }

  let converted: unknown;
  try {
    converted = convert.call(jsonSchema, { target: "draft-07" });
  } catch (error) {
    throw new Error(
      `defineCapability("${label}"): "${field}" Standard JSON Schema conversion failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
    throw new Error(
      `defineCapability("${label}"): "${field}" Standard JSON Schema converter did not return a schema object.`,
    );
  }

  // Draft converters commonly include this root declaration. Pracht already
  // chooses the requested draft and validates a deliberate keyword subset, so
  // retaining it would make an otherwise compatible schema look unsupported.
  const portable = { ...(converted as Record<string, unknown>) };
  delete portable.$schema;
  return portable;
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
  if (definition.name !== undefined && !isValidCapabilityName(definition.name)) {
    throw new Error(
      `defineCapability("${label}"): "name" must be dot-separated segments of letters, ` +
        'numbers, hyphens, and underscores — for example "notes.search".',
    );
  }

  for (const field of ["input", "output"] as const) {
    const schema = definition[field];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`defineCapability("${label}"): "${field}" must be a JSON Schema object.`);
    }
    const unsupported = collectUnsupportedSchemaKeywords(schema);
    const invalid = collectInvalidSchemaKeywordValues(schema);
    if (unsupported.length > 0) {
      throw new Error(
        `defineCapability("${label}"): "${field}" schema uses unsupported JSON Schema keywords: ` +
          `${unsupported.join(", ")}. Supported keywords: type (object/array/string/number/` +
          "integer/boolean/null), properties, required, additionalProperties, items, enum, " +
          "const, minimum, maximum, minLength, maxLength, default, title, description.",
      );
    }
    if (invalid.length > 0) {
      throw new Error(
        `defineCapability("${label}"): "${field}" schema has invalid JSON Schema values: ` +
          `${invalid.join(", ")}.`,
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
      if (!isValidCapabilityHttpPath(expose.http.path)) {
        throw new Error(
          'Capability HTTP exposure "path" must be an exact same-origin pathname starting with "/".',
        );
      }
      http = { method: "POST", path: expose.http.path };
    } else {
      http = { method: "POST" };
    }
  }

  let webmcp = false;
  let webmcpUntrustedContent = false;
  if (expose.webmcp === true) {
    webmcp = true;
  } else if (expose.webmcp && typeof expose.webmcp === "object" && !Array.isArray(expose.webmcp)) {
    if (
      expose.webmcp.untrustedContent !== undefined &&
      typeof expose.webmcp.untrustedContent !== "boolean"
    ) {
      throw new Error('Capability WebMCP exposure "untrustedContent" must be a boolean.');
    }
    webmcp = true;
    webmcpUntrustedContent = expose.webmcp.untrustedContent === true;
  } else if (expose.webmcp !== undefined && expose.webmcp !== false && expose.webmcp !== null) {
    throw new Error('Capability "expose.webmcp" must be a boolean or an options object.');
  }

  const normalized: CapabilityExposure = {
    http,
    mcp: expose.mcp === true,
    webmcp,
    webmcpUntrustedContent,
  };

  if (!normalized.http && !normalized.mcp && !normalized.webmcp) return null;
  return normalized;
}
