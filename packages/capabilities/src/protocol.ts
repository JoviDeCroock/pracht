/**
 * The capability wire contract — the single home for every name the
 * projections share: the HTTP path formula, the confirmation header, and the
 * envelope error codes. The framework runtime, the Vite plugin's generated
 * client modules, and the CLI (eval runner, verify, typegen) all import from
 * here, so the protocol cannot drift between packages.
 */

export const CAPABILITY_HTTP_PREFIX = "/api/capabilities/";

/** Default HTTP path for a capability name: dots become slashes. */
export function capabilityHttpPath(name: string): string {
  return `${CAPABILITY_HTTP_PREFIX}${name.split(".").join("/")}`;
}

/** Normalize a dispatch path for matching: strip a single trailing slash. */
export function normalizeCapabilityHttpPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Whether a custom capability endpoint is an exact same-origin pathname.
 *
 * Parsing against a fixed origin catches protocol-relative paths, backslashes,
 * ASCII control characters, dot-segment normalization, queries, and fragments.
 * Requiring the parsed pathname to equal the source keeps generated browser
 * fetches on the application origin.
 */
export function isValidCapabilityHttpPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  try {
    const parsed = new URL(path, "https://pracht.invalid");
    return (
      parsed.origin === "https://pracht.invalid" &&
      parsed.pathname === path &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * Header that carries the prepare/commit confirmation token when committing a
 * destructive capability call (see docs/AGENT_TRUST.md).
 */
export const CONFIRMATION_HEADER = "x-pracht-confirm";

/** Environment variable holding the confirmation-token HMAC secret. */
export const CONFIRMATION_SECRET_ENV = "PRACHT_CONFIRMATION_SECRET";

/**
 * Every error code a capability envelope can carry. The first group is
 * produced by the server dispatch pipeline; `network_error` and
 * `invalid_response` are produced client-side by the generated
 * `callCapability()` helper when the endpoint cannot be reached or answers
 * with something other than the envelope.
 */
export const CAPABILITY_ERROR_CODES = [
  "invalid_input",
  "invalid_output",
  "invalid_json",
  "internal_error",
  "method_not_allowed",
  "agent_required",
  "confirmation_required",
  "confirmation_unavailable",
  "confirmation_invalid",
  "unknown_capability",
  "unauthorized",
  "forbidden",
  "middleware_rejected",
  "redirect",
  "cross_origin_blocked",
  "network_error",
  "invalid_response",
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

/**
 * Optional transport marker the generated WebMCP shim sends with its
 * dispatches so audit events can distinguish in-browser agent traffic
 * (cookie-authenticated) from remote HTTP callers. Informational only — like
 * any client-sent header it is not a trust signal.
 */
export const CAPABILITY_TRANSPORT_HEADER = "x-pracht-transport";

/**
 * Response header carrying the matched capability's effect class. Enhanced
 * `<Form capability>` submissions read it so successful `read` operations do
 * not invalidate route data while mutations still do.
 */
export const CAPABILITY_EFFECT_HEADER = "x-pracht-capability-effect";

/**
 * Window event dispatched after a browser-side capability call settles —
 * by the generated `callCapability()` helper and by `<Form capability>`.
 * The framework's route runtime listens and revalidates the active route's
 * data after successful non-`read` calls, so mutations made through the
 * agent surface and the human UI keep the page consistent the same way.
 * `detail`: `{ name, effect, ok, revalidate }` (`effect`/`revalidate` may be
 * absent when an older or non-Pracht dispatcher doesn't know them).
 */
export const CAPABILITY_SETTLED_EVENT = "pracht:capability-settled";

/**
 * Verified agent identity, surfaced as `context.agent` when the app
 * configures Web Bot Auth (`defineApp({ agents: { webBotAuth } })`).
 */
export interface PrachtAgentIdentity {
  verified: true;
  /** Host of the agent's Signature-Agent directory URL (or the static key's `agent` label). */
  agentDomain: string | null;
  /** The `keyid` signature parameter (base64url JWK thumbprint). */
  keyId: string;
}
