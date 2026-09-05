/**
 * Shared types for the capability server core.
 *
 * These are the data shapes the dispatch pipeline, agent trust layer, and
 * MCP projection operate on. They were defined in `@pracht/core` originally
 * and moved here — the protocol-owning leaf package — so the pipeline can be
 * hosted outside a pracht app; `@pracht/core` re-exports every one of them,
 * so framework consumers keep one import surface.
 *
 * Everything here is serializable data or a structural function type — no
 * framework, DOM, or Node dependencies.
 */

import type { Capability, CapabilityAgentPolicy, CapabilityEffect } from "../capability.ts";
import type { PrachtAgentIdentity } from "../protocol.ts";

export type AgentPolicyMode = CapabilityAgentPolicy;

/** A statically configured agent verification key (public Ed25519 JWK material). */
export interface WebBotAuthStaticKey {
  /** Base64url raw Ed25519 public key — the JWK `x` member. */
  x: string;
  /**
   * Key id the agent sends as `keyid`. Defaults to the RFC 8037 JWK SHA-256
   * thumbprint computed from `x`, which is what Web Bot Auth agents send.
   */
  kid?: string;
  /** Label reported as `agentDomain` when the request has no Signature-Agent header. */
  agent?: string;
}

export interface WebBotAuthConfig {
  /**
   * App-wide default policy for capability HTTP endpoints.
   * - `"observe"` (default): verify and surface `context.agent`, serve everyone.
   * - `"require"`: unsigned/unverified requests to capability HTTP endpoints
   *   get a 401 envelope. Individual capabilities can override via `agentPolicy`.
   */
  policy?: AgentPolicyMode;
  /** Statically trusted keys (tests, air-gapped deploys, pinned agents). */
  keys?: WebBotAuthStaticKey[];
  /**
   * Origins (e.g. `"https://signature-agent.example"`) whose
   * `/.well-known/http-message-signatures-directory` may be fetched to
   * resolve unknown key ids. Fetching is allowlist-only: an unlisted
   * Signature-Agent fails verification instead of triggering a fetch
   * (fail closed, no SSRF surface).
   */
  directories?: string[];
  /** Allowed clock skew when checking `created`/`expires`, seconds. Default 60. */
  clockSkewSeconds?: number;
  /** Maximum accepted signature lifetime (`expires - created`), seconds. Default 86400 (24h, per draft guidance). */
  maxLifetimeSeconds?: number;
  /** In-memory TTL for fetched key directories, seconds. Default 300. */
  directoryCacheTtlSeconds?: number;
}

export interface CapabilityConfirmationConfig {
  /** Confirmation token TTL, seconds. Default 120. */
  ttlSeconds?: number;
  /**
   * Best-effort single-use enforcement via an in-memory, per-instance cache.
   * Stateless HMAC tokens cannot prevent replay across instances or
   * restarts — see docs/AGENT_TRUST.md for the honest limitations. Ignored
   * when an approval store is registered: the store enforces single use
   * durably.
   */
  singleUse?: boolean;
  /**
   * Who decides that a destructive call may proceed.
   *
   * - `"token"` (default) — the caller commits with the confirmation token it
   *   was handed. With an approval store registered this also becomes
   *   exactly-once across replicas.
   * - `"human"` — the commit is refused with `confirmation_pending` until a
   *   person approves the proposal out of band. Requires an approval store and
   *   an authenticated principal from Web Bot Auth or
   *   `setCapabilityApprovalPrincipalResolver()`; without both, destructive
   *   calls fail closed.
   */
  mode?: "token" | "human";
}

/** Lifecycle of a destructive-capability approval proposal. */
export type CapabilityApprovalState = "pending" | "approved" | "rejected" | "consumed";

/**
 * One pending destructive operation, keyed by what it *is* rather than by the
 * token that happened to be minted for it: `id` is a secret-keyed digest of the
 * principal, capability name, canonicalized input, and approval mode. Repeated
 * prepare calls for the same operation and mode therefore address the same
 * proposal, so a person approves an action rather than one particular token.
 */
export interface CapabilityApprovalRecord {
  /** Secret-keyed from principal + capability + input hash + mode; never client-supplied. */
  id: string;
  /** Verified agent and/or application identity, or `"anonymous"` in token mode. */
  principal: string;
  capability: string;
  /** Base64url SHA-256 of the canonicalized validated input. */
  inputHash: string;
  /** The validated input, so a reviewer can see what they are approving. */
  input: unknown;
  /** Whether this proposal must be approved before it can be consumed. */
  requiresApproval: boolean;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds; the proposal is dead after this even if still stored. */
  expiresAt: number;
  state: CapabilityApprovalState;
  /** Whoever called `decide()`; application-defined (user id, email, ...). */
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface CapabilityApprovalPrincipalArgs<TContext = unknown> {
  /** Request context after API and capability middleware have run. */
  context: TContext;
  request: Request;
  capability: string;
  agent: PrachtAgentIdentity | null;
}

/**
 * Resolve the application-authenticated identity bound to a destructive
 * proposal. Return a stable user/tenant id, never a display name or a value
 * supplied directly by the caller.
 */
export type CapabilityApprovalPrincipalResolver<TContext = unknown> = (
  args: CapabilityApprovalPrincipalArgs<TContext>,
) => string | null | Promise<string | null>;

export type CapabilityApprovalConsumeFailure =
  | "unknown"
  | "expired"
  | "already_used"
  | "awaiting_approval"
  | "rejected";

export type CapabilityApprovalConsumeResult =
  | { ok: true; record: CapabilityApprovalRecord }
  | { ok: false; reason: CapabilityApprovalConsumeFailure };

/**
 * Durable storage for destructive-capability approvals, registered with
 * `setCapabilityApprovalStore()`.
 *
 * `create()` and `consume()` both carry hard concurrency requirements:
 * `create()` MUST atomically insert-if-absent and return the existing live
 * proposal on conflict; `consume()` MUST be a compare-and-set, not a read
 * followed by a write. A prepare racing a commit must never resurrect a
 * consumed proposal, and two replicas committing concurrently must produce
 * exactly one `ok: true`. A backend without conditional writes (e.g.
 * Cloudflare KV) cannot implement this; D1, Durable Objects, Postgres, and
 * Redis can. See docs/AGENT_TRUST.md for reference SQL statements.
 *
 * Implementations own their clock and compare against `record.expiresAt`.
 */
export interface CapabilityApprovalStore {
  /**
   * Record a proposal with an atomic insert-if-absent. When a live proposal
   * with the same `id` already exists it must be returned unchanged, so a
   * concurrent re-prepare cannot extend its life, reset a decision, or
   * resurrect it after consumption. Consumed/rejected records remain live
   * until `expiresAt`; the same operation can be proposed again after expiry.
   */
  create(record: CapabilityApprovalRecord): Promise<CapabilityApprovalRecord>;
  get(id: string): Promise<CapabilityApprovalRecord | null>;
  /** Unexpired proposals still awaiting a decision, for a review surface. */
  listPending(): Promise<CapabilityApprovalRecord[]>;
  /**
   * Record a human decision. Returns `false` when the proposal is unknown,
   * expired, or already decided or consumed.
   */
  decide(id: string, decision: "approved" | "rejected", by: string): Promise<boolean>;
  /** Atomically consume an eligible proposal, enforcing its stored approval requirement. */
  consume(id: string): Promise<CapabilityApprovalConsumeResult>;
}

/**
 * Serve capabilities that set `expose.mcp` over stateless Streamable HTTP at
 * a single endpoint. Omitting this leaves `expose.mcp` recorded in the graph
 * but unserved.
 */
export interface McpProjectionConfig {
  /** Exact same-origin endpoint pathname. Default `/mcp`. */
  path?: string;
  /** Reported by `initialize`. Defaults to `{ name: "pracht", version: "0.0.0" }`. */
  serverInfo?: { name: string; version: string };
  /** Optional free-text guidance returned by `initialize`. */
  instructions?: string;
  /**
   * Serve `destructive` capabilities that set `expose.mcp` as MCP tools. Off
   * by default: the projection filters destructive effects out of `tools/list`
   * and `tools/call`, and nested `invokeCapability()` refuses them.
   *
   * Turning it on keeps the server-verified prepare/commit flow — the first
   * `tools/call` answers `confirmation_required` with a token, and the commit
   * repeats the call with identical arguments plus
   * `_meta["io.pracht/confirmation"]`. Because a token can be replayed until it
   * expires, the endpoint requires a registered
   * {@link CapabilityApprovalStore} (`setCapabilityApprovalStore()`) for
   * exactly-once commits and fails closed without one.
   */
  destructive?: boolean;
  /**
   * Turn the endpoint into an OAuth 2.0 protected resource. See
   * {@link McpAuthConfig}. Omit it and nothing changes: no metadata route, no
   * `WWW-Authenticate` header, and authentication stays your middleware's job.
   */
  auth?: McpAuthConfig;
}

/**
 * The application-authenticated caller behind an OAuth bearer token, as
 * returned by {@link McpTokenVerifier}. Surfaced as `context.tokenAuth`.
 *
 * Only `subject` is required; it must be a stable identifier (user id, tenant
 * id, client id) and never a caller-controlled display value.
 */
export interface McpTokenPrincipal {
  /** Stable subject identifier — the OAuth `sub` claim, typically. */
  subject: string;
  /** Scopes the token actually carries; used for the `insufficient_scope` gate. */
  scopes?: readonly string[];
  /** OAuth client the token was issued to, when the app can determine it. */
  clientId?: string | null;
  /**
   * Anything else the app wants downstream. Frozen **shallowly**: own keys are
   * locked, nested values are whatever the verifier returned. The principal is
   * bound to a request-local context overlay and never written back to an
   * adapter-supplied context object.
   */
  claims?: Readonly<Record<string, unknown>>;
}

export interface McpTokenVerifyArgs {
  /**
   * An independent clone of the MCP transport request, for issuer/audience or
   * per-tenant checks. Reading its body does not consume the JSON-RPC body the
   * framework dispatches afterward.
   */
  request: Request;
}

/**
 * Verify one bearer token. Return the principal it authenticates, or `null` to
 * reject. Pracht deliberately does not own JWT/JWKS validation: the hook is
 * where your identity provider's library lives.
 *
 * Fails closed — a thrown error is treated exactly like `null`.
 */
export type McpTokenVerifier = (
  token: string,
  args: McpTokenVerifyArgs,
) => McpTokenPrincipal | null | Promise<McpTokenPrincipal | null>;

/** Module whose default export is a {@link McpTokenVerifier}. */
export interface McpTokenVerifierModule {
  default: McpTokenVerifier;
}

/**
 * OAuth 2.0 protected-resource configuration for the remote MCP endpoint.
 *
 * Serves `/.well-known/oauth-protected-resource` per
 * [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) and answers unauthenticated
 * `/mcp` requests with the `WWW-Authenticate` challenge the MCP authorization
 * spec (2025-06-18) tells hosts to follow. Pracht is the resource server only —
 * it never becomes an authorization server.
 */
export interface McpAuthConfig {
  /**
   * Absolute URL identifying this MCP resource — the audience (RFC 8707) tokens
   * must be bound to, and the identifier in the metadata document. No query or
   * fragment; its path must exactly match the served MCP endpoint's public path,
   * including any deploy base. Requests for any other URL are redirected here
   * before authentication.
   */
  resource: string;
  /** Absolute issuer URLs of the authorization servers that may mint tokens. At least one. */
  authorizationServers: readonly string[];
  /** OAuth scope tokens advertised in the metadata document so hosts know what to request. */
  scopesSupported?: readonly string[];
  /**
   * OAuth scope tokens every `/mcp` call must carry. A verified token missing
   * any of them gets `403 insufficient_scope` instead of running a tool.
   */
  requiredScopes?: readonly string[];
  /** Human-facing documentation URL, advertised as `resource_documentation`. */
  resourceDocumentation?: string;
  /**
   * The token verifier. In a pracht app this is a server-only module reference
   * (a module path string after manifest resolution) because the manifest is
   * bundled into the client and a token verifier must never be. A standalone
   * host (`createCapabilityHost()`) registers the verifier function directly
   * instead.
   */
  verify: string | (() => Promise<unknown>);
}

export interface PrachtAgentsConfig {
  /** Verify RFC 9421 / Web Bot Auth agent signatures and surface `context.agent`. */
  webBotAuth?: WebBotAuthConfig;
  /** Prepare/commit confirmation flow options for destructive capabilities. */
  confirmation?: CapabilityConfirmationConfig;
  /** Serve `expose.mcp` capabilities as MCP tools. See {@link McpProjectionConfig}. */
  mcp?: McpProjectionConfig;
}

/** Structured audit event emitted for every capability dispatch. */
export interface CapabilityAuditEvent {
  readonly capability: string;
  readonly effect: CapabilityEffect;
  /**
   * How the capability was invoked. `"mcp"` is trusted internal dispatch
   * state from the remote MCP projection. `"webmcp"` reflects the transport
   * marker the generated WebMCP shim sends with its dispatches — informational,
   * not a trust signal (any HTTP client can send the header).
   */
  readonly transport: "http" | "server" | "webmcp" | "mcp";
  /**
   * Which request a `transport: "server"` dispatch was composed under.
   * `invokeCapability()` normally runs only the capability's own middleware
   * chain; MCP-originated composition additionally enforces agent policy and
   * refuses destructive effects. `via` keeps every allowed or denied nested
   * call attributable to its originating transport. `null` for top-level
   * dispatches (`transport` already says how they arrived) and for invocation
   * outside a served request (test hosts, scripts). Never reports `"webmcp"`:
   * that marker is client-declared, so it is not trustworthy enough to
   * attribute a nested effect to.
   */
  readonly via: "http" | "mcp" | null;
  /** `"ok"` or the envelope error code (e.g. `"invalid_input"`, `"confirmation_required"`). */
  readonly outcome: string;
  /** HTTP status the envelope maps to (also set for server-side invocation). */
  readonly status: number;
  readonly durationMs: number;
  /** Verified OAuth subject and client, or null outside authenticated MCP dispatch.
   * Tokens, scopes and arbitrary claims are deliberately excluded from audit events.
   */
  readonly tokenAuth: Readonly<Pick<McpTokenPrincipal, "subject" | "clientId">> | null;
  /** Verified agent identity, `null` when unsigned/unverified or Web Bot Auth is off. */
  readonly agent: PrachtAgentIdentity | null;
}

export type CapabilityAuditHook = (event: CapabilityAuditEvent) => void;

/**
 * Fields the framework surfaces on the request context, merged into the
 * app-registered context type so loaders, middleware, API routes, and
 * capabilities all see them without casts.
 */
export interface PrachtContextExtensions {
  /**
   * Verified agent identity (Web Bot Auth); `null` when the request is
   * unsigned or fails verification, absent when Web Bot Auth is not
   * configured.
   */
  readonly agent?: PrachtAgentIdentity | null;
  /**
   * Principal returned by the `agents.mcp.auth.verify` hook for an OAuth
   * bearer token presented to the remote MCP endpoint. Absent on every other
   * request path and when `agents.mcp.auth` is not configured — an
   * unauthenticated MCP request never reaches application code.
   */
  readonly tokenAuth?: McpTokenPrincipal | null;
}

// ---------------------------------------------------------------------------
// Module registry and middleware glue
// ---------------------------------------------------------------------------

export type ModuleImporter<TModule = unknown> = () => Promise<TModule>;

/** The erased-generics view of `defineCapability()`'s return value the runtime executes. */
export type PrachtCapability<TContext = any> = Capability<any, unknown, TContext>;

export interface CapabilityModule<TContext = any> {
  default: PrachtCapability<TContext>;
}

export type MiddlewareNext = () => Promise<Response>;

/**
 * Route descriptor middleware receives via `args.route`. Typed loosely here:
 * the framework passes its resolved page/API route objects through unchanged,
 * and capability dispatch passes a synthetic `{ path, file, segments }`
 * descriptor.
 */
export interface CapabilityRouteDescriptor {
  path: string;
  file: string;
  segments: unknown[];
}

export interface MiddlewareArgs<TContext = any> {
  request: Request;
  params: Record<string, string>;
  /** Matched pathname without any deployment base. */
  pathname?: string;
  context: TContext;
  signal: AbortSignal;
  url: URL;
  route: any;
}

export type MiddlewareFn<TContext = any> = (
  args: MiddlewareArgs<TContext>,
  next: MiddlewareNext,
) => Response | Promise<Response>;

export interface MiddlewareModule<TContext = any> {
  middleware: MiddlewareFn<TContext>;
}

/**
 * The slices of the framework's module registry the capability core reads.
 * `@pracht/core`'s full `ModuleRegistry` (routes, shells, data, API modules)
 * is structurally assignable to this.
 */
export interface CapabilityModuleRegistry {
  middlewareModules?: Record<string, ModuleImporter<MiddlewareModule>>;
  capabilityModules?: Record<string, ModuleImporter<CapabilityModule>>;
  dataModules?: Record<string, ModuleImporter>;
}
