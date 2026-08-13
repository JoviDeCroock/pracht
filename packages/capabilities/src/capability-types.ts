import type { CapabilityErrorCode, PrachtAgentIdentity } from "./protocol.ts";
import type { CapabilityIssue, JsonSchema } from "./schema.ts";

/**
 * Side-effect classification. Every capability must declare one; framework
 * exposure and cache policy are driven by it. Destructive capabilities are
 * HTTP-only behind server-verified prepare/commit confirmation in v1.
 */
export type CapabilityEffect = "read" | "write" | "destructive";

/**
 * Web Bot Auth policy for the capability's HTTP endpoint. `observe` serves
 * everyone and surfaces verified identity; `require` rejects unverified calls.
 * Unset inherits the app-wide policy.
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
  /** Advertise the capability to the configured remote MCP projection. */
  mcp?: boolean;
  /** Register a WebMCP page tool. Requires HTTP for server-side enforcement. */
  webmcp?: boolean;
}

/** Normalized exposure consumed by runtime and graph layers. */
export interface CapabilityExposure {
  http: CapabilityHttpExposure | null;
  mcp: boolean;
  webmcp: boolean;
}

/**
 * Default request context for capability handlers: the verified agent
 * identity plus application middleware fields. Apps can narrow the open part
 * with the third `defineCapability` generic.
 */
export interface CapabilityContext {
  /** Verified Web Bot Auth identity, or null when unsigned/unverified. */
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
  title: string;
  description: string;
  /** JSON Schema (supported subset) for the capability input. */
  input: JsonSchema;
  /** JSON Schema (supported subset) for the capability output. */
  output: JsonSchema;
  effect: CapabilityEffect;
  /** Named middleware from the app manifest, run before the handler. */
  middleware?: string[];
  /** Explicit exposure. A capability without `expose` is server-only. */
  expose?: CapabilityExposeConfig;
  /** Per-capability Web Bot Auth policy override for the HTTP endpoint. */
  agentPolicy?: CapabilityAgentPolicy;
  run: (args: CapabilityRunArgs<TInput, TContext>) => TOutput | Promise<TOutput>;
}

export type CapabilityValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; issues: CapabilityIssue[] };

/**
 * Structural runtime contract returned by `defineCapability()`. Validation is
 * attached so the framework can execute it without depending on construction
 * internals.
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
  validateInput: (value: unknown) => CapabilityValidationResult<TInput>;
  validateOutput: (value: unknown) => CapabilityValidationResult<TOutput>;
}

/** Result/error envelope shared by HTTP, WebMCP, and direct invocation. */
export type CapabilityEnvelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: CapabilityErrorPayload };

export interface CapabilityErrorPayload {
  code: CapabilityErrorCode;
  message: string;
  issues?: CapabilityIssue[];
  /** Present on `confirmation_required`: return via the confirmation header. */
  confirmationToken?: string;
  /** Unix seconds when `confirmationToken` expires. */
  expiresAt?: number;
  /**
   * Durable approval proposal id on confirmation-required/pending envelopes,
   * derived server-side from principal, capability, and input.
   */
  approvalId?: string;
}
