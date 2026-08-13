/**
 * Server-verified prepare/commit confirmation for destructive capabilities.
 *
 * A destructive capability exposed over HTTP never runs on the first call.
 * The first (prepare) call returns a `confirmation_required` envelope with a
 * short-lived token: an HMAC-SHA256 (WebCrypto) over the caller's principal,
 * the capability name, a hash of the canonicalized (stable-JSON) validated
 * input, and an expiry. The second (commit) call presents the token in the
 * `x-pracht-confirm` header with byte-identical canonical input; anything
 * else — tampering, expiry, different input, different principal — fails
 * closed with 403.
 *
 * Honest limitation: a stateless HMAC cannot prevent replay *within* the TTL.
 * True single-use requires shared storage; the optional in-memory replay cache
 * is best effort and per-instance only (documented in docs/AGENT_TRUST.md).
 * Register a `CapabilityApprovalStore` (see runtime-approval.ts) for durable
 * exactly-once commits and optional human approval. Token encoding and
 * verification live in `runtime-confirmation-token.ts`; the replay cache lives
 * in `runtime-confirmation-replay.ts` behind this stable facade.
 *
 * The secret comes from `PRACHT_CONFIRMATION_SECRET` or
 * `setCapabilityConfirmationSecret()` — never from the app manifest, which is
 * bundled into the client.
 */

import { CONFIRMATION_HEADER, CONFIRMATION_SECRET_ENV } from "@pracht/capabilities";
import { serverEnv } from "./env-server.ts";

export { CONFIRMATION_HEADER, CONFIRMATION_SECRET_ENV };
export const DEFAULT_CONFIRMATION_TTL_SECONDS = 120;

let programmaticSecret: string | null = null;

/**
 * Configure the confirmation secret at runtime — for platforms where
 * `process.env` is unavailable (e.g. Cloudflare Workers without
 * `nodejs_compat`). Takes precedence over the environment variable.
 */
export function setCapabilityConfirmationSecret(secret: string | null): void {
  programmaticSecret = secret;
}

export function resolveConfirmationSecret(): string | null {
  if (programmaticSecret) return programmaticSecret;
  try {
    const secret = serverEnv[CONFIRMATION_SECRET_ENV];
    return typeof secret === "string" && secret !== "" ? secret : null;
  } catch {
    // Cloudflare bindings are installed when a request enters the adapter.
    // Before that point there is intentionally no ambient environment.
    return null;
  }
}

export {
  canonicalJson,
  createConfirmationToken,
  hmacSha256Base64Url,
  sha256Base64Url,
  verifyConfirmationToken,
} from "./runtime-confirmation-token.ts";
export type {
  CapabilityConfirmationMode,
  ConfirmationBinding,
  ConfirmationFailure,
  ConfirmationVerification,
} from "./runtime-confirmation-token.ts";
export {
  clearConsumedConfirmationTokens,
  consumeConfirmationToken,
} from "./runtime-confirmation-replay.ts";
