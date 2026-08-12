import type {
  CapabilityAgentPolicy,
  CapabilityEffect,
  PrachtAgentIdentity,
} from "@pracht/capabilities";

import type { PrachtRequestContext } from "./registration.ts";

// Agent trust layer (Web Bot Auth + destructive-capability confirmation).
// Everything in the manifest's `agents` section is serializable public data:
// confirmation secrets stay in environment/runtime configuration, never here.

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

export interface CapabilityApprovalPrincipalArgs<TContext = PrachtRequestContext> {
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
export type CapabilityApprovalPrincipalResolver<TContext = PrachtRequestContext> = (
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
  /** Verified agent identity, `null` when unsigned/unverified or Web Bot Auth is off. */
  readonly agent: PrachtAgentIdentity | null;
}

export type CapabilityAuditHook = (event: CapabilityAuditEvent) => void;
