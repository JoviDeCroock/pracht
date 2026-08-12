/**
 * Web Bot Auth: verified agent identity over RFC 9421 HTTP Message Signatures.
 *
 * Implements the verifier side of
 * draft-meunier-web-bot-auth-architecture-02 (protocol) and
 * draft-meunier-http-message-signatures-directory-03 (key discovery):
 *
 *   Signature-Agent: "https://signature-agent.example"
 *   Signature-Input: sig=("@authority" "signature-agent");created=...;
 *                    expires=...;keyid="<jwk-thumbprint>";alg="ed25519";
 *                    nonce="...";tag="web-bot-auth"
 *   Signature:       sig=:<base64 ed25519 signature>:
 *
 * Everything is Web-platform only (Headers, fetch, crypto.subtle) so Node,
 * Cloudflare, and Vercel adapters share one implementation.
 *
 * The verifier fails closed: any parse error, missing component, expired or
 * not-yet-valid window, unknown key, or bad signature yields `null`, never a
 * partially trusted identity.
 */

import { fetchAgentDirectory, resolveStaticAgentKey } from "./runtime-agent-directory.ts";
import {
  buildSignatureBase,
  decodeBase64,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
} from "./runtime-agent-signature.ts";
import type { PrachtAgentIdentity, WebBotAuthConfig } from "./types.ts";

export {
  clearAgentDirectoryCache,
  ed25519JwkThumbprint,
  parseDirectoryJwks,
  SIGNATURE_AGENT_DIRECTORY_PATH,
} from "./runtime-agent-directory.ts";

export {
  buildSignatureBase,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
} from "./runtime-agent-signature.ts";

/** The draft requires this tag; signatures with other tags are ignored. */
const WEB_BOT_AUTH_TAG = "web-bot-auth";

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
/** Draft recommends signature expiry "no more than 24 hours" after creation. */
const DEFAULT_MAX_LIFETIME_SECONDS = 86_400;
const DEFAULT_DIRECTORY_CACHE_TTL_SECONDS = 300;

const encoder = new TextEncoder();

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(normalized);
}

export interface VerifyAgentSignatureOptions extends WebBotAuthConfig {
  /** Injectable clock (unix seconds) and fetch for tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Verify a Web Bot Auth signature on the request. Resolves to the verified
 * agent identity, or `null` when the request is unsigned or verification
 * fails for any reason (fail closed — this function never throws).
 */
export async function verifyAgentSignature(
  request: Request,
  options: VerifyAgentSignatureOptions,
): Promise<PrachtAgentIdentity | null> {
  try {
    return await verifyAgentSignatureUnsafe(request, options);
  } catch {
    return null;
  }
}

async function verifyAgentSignatureUnsafe(
  request: Request,
  options: VerifyAgentSignatureOptions,
): Promise<PrachtAgentIdentity | null> {
  const signatureInputHeader = request.headers.get("signature-input");
  const signatureHeader = request.headers.get("signature");
  if (!signatureInputHeader || !signatureHeader) return null;

  const members = parseSignatureInput(signatureInputHeader);
  const signatures = parseSignatureHeader(signatureHeader);
  if (!members || !signatures) return null;

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;

  // The Signature-Agent value is an sf-string containing the directory URL.
  const signatureAgentHeader = request.headers.get("signature-agent");
  const agentUrl = signatureAgentHeader ? parseSignatureAgent(signatureAgentHeader) : null;
  if (signatureAgentHeader && !agentUrl) return null;

  for (const member of members) {
    // Only web-bot-auth signatures concern us; other tags are ignored.
    if (member.params.tag !== WEB_BOT_AUTH_TAG) continue;

    const signature = signatures[member.label];
    if (!signature) continue;

    // Required covered components: @authority always; signature-agent
    // whenever the header is present (draft §4.2.1).
    if (!member.components.includes("@authority")) continue;
    if (signatureAgentHeader && !member.components.includes("signature-agent")) continue;

    // Required parameters and freshness window (with clock-skew allowance).
    const { created, expires, keyid, alg } = member.params;
    if (typeof created !== "number" || typeof expires !== "number") continue;
    if (typeof keyid !== "string" || keyid === "") continue;
    if (alg !== undefined && alg !== "ed25519") continue;
    if (expires <= created || expires - created > maxLifetime) continue;
    if (created > now + skew) continue;
    if (expires < now - skew) continue;

    // Key resolution: static keys first, then the allowlisted directory.
    let key = await resolveStaticAgentKey(options.keys, keyid);
    let resolvedFromDirectory = false;
    let agentDomain = key?.agent ?? null;
    if (!key && agentUrl) {
      const allowed = (options.directories ?? []).some(
        (directory) => normalizeOrigin(directory) === agentUrl.origin,
      );
      if (allowed) {
        const directoryKeys = await fetchAgentDirectory(
          agentUrl.origin,
          options.directoryCacheTtlSeconds ?? DEFAULT_DIRECTORY_CACHE_TTL_SECONDS,
          options.fetchImpl ?? fetch,
        );
        key = directoryKeys.find((candidate) => candidate.keyId === keyid) ?? null;
        resolvedFromDirectory = key !== null;
      }
    }
    if (!key) continue;
    if (resolvedFromDirectory && agentUrl) agentDomain = agentUrl.host;

    const base = buildSignatureBase(request, member);
    if (base === null) continue;

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64UrlDecode(key.x)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      toArrayBuffer(signature),
      encoder.encode(base),
    );
    if (valid) {
      return { verified: true, agentDomain, keyId: keyid };
    }
  }

  return null;
}

/** Copy into a fresh ArrayBuffer — some WebCrypto impls reject SharedArrayBuffer views. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
