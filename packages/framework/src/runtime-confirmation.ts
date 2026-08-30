/**
 * Server-verified prepare/commit confirmation for destructive capabilities.
 * The implementation lives in `@pracht/capabilities/server` — the capability
 * core — so a standalone host enforces the identical flow; re-exported here
 * because it has always been part of `@pracht/core`'s surface.
 */

export {
  canonicalJson,
  clearConsumedConfirmationTokens,
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  consumeConfirmationToken,
  createConfirmationToken,
  DEFAULT_CONFIRMATION_TTL_SECONDS,
  hmacSha256Base64Url,
  isWellFormedConfirmationToken,
  resolveConfirmationSecret,
  setCapabilityConfirmationSecret,
  sha256Base64Url,
  verifyConfirmationToken,
  type CapabilityConfirmationMode,
  type ConfirmationBinding,
  type ConfirmationFailure,
  type ConfirmationVerification,
} from "@pracht/capabilities/server";
