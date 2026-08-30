/**
 * Web Bot Auth: verified agent identity over RFC 9421 HTTP Message
 * Signatures. The verifier lives in `@pracht/capabilities/server` — the
 * capability core — so a standalone host verifies identically; re-exported
 * here because it has always been part of `@pracht/core`'s surface.
 */

export {
  clearAgentDirectoryCache,
  ed25519JwkThumbprint,
  hasWebBotAuthIdentitySource,
  parseDirectoryJwks,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
  SIGNATURE_AGENT_DIRECTORY_PATH,
  verifyAgentSignature,
  type VerifyAgentSignatureOptions,
} from "@pracht/capabilities/server";
