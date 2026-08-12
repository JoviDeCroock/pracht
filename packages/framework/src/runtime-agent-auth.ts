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

import type { PrachtAgentIdentity, WebBotAuthConfig, WebBotAuthStaticKey } from "./types.ts";
import {
  buildSignatureBase,
  decodeBase64,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
} from "./runtime-agent-signature.ts";

export {
  buildSignatureBase,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
} from "./runtime-agent-signature.ts";

export const SIGNATURE_AGENT_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** The draft requires this tag; signatures with other tags are ignored. */
const WEB_BOT_AUTH_TAG = "web-bot-auth";

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
/** Draft recommends signature expiry "no more than 24 hours" after creation. */
const DEFAULT_MAX_LIFETIME_SECONDS = 86_400;
const DEFAULT_DIRECTORY_CACHE_TTL_SECONDS = 300;
/** Cap on directory response bodies — a JWKS is tiny; anything bigger is hostile. */
const DIRECTORY_MAX_BYTES = 65_536;
const DIRECTORY_FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(normalized);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 8037 Appendix A.3 JWK thumbprint for an Ed25519 public key: SHA-256
 * over the canonical `{"crv","kty","x"}` JSON, base64url encoded. This is
 * the `keyid` Web Bot Auth agents send.
 */
export async function ed25519JwkThumbprint(x: string): Promise<string> {
  const canonical = JSON.stringify({ crv: "Ed25519", kty: "OKP", x });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

interface ResolvedAgentKey {
  keyId: string;
  /** Base64url raw public key (JWK `x`). */
  x: string;
  /** Agent label for identities resolved from static keys. */
  agent: string | null;
}

/** Directory cache: origin → { keys, expiresAt (ms) }. Per-instance, best effort. */
const directoryCache = new Map<string, { keys: ResolvedAgentKey[]; expiresAt: number }>();

/** Test hook — clears the module-level directory cache. */
export function clearAgentDirectoryCache(): void {
  directoryCache.clear();
}

async function resolveStaticKey(
  keys: WebBotAuthStaticKey[] | undefined,
  keyId: string,
): Promise<ResolvedAgentKey | null> {
  for (const key of keys ?? []) {
    if (typeof key.x !== "string" || key.x === "") continue;
    const kid = key.kid ?? (await ed25519JwkThumbprint(key.x));
    if (kid === keyId) {
      return { keyId, x: key.x, agent: key.agent ?? null };
    }
  }
  return null;
}

/**
 * Fetch and parse an agent's key directory (JWKS) with strict validation:
 * https only, allowlisted origin, no redirects, response size cap, Ed25519
 * OKP keys only, and each key's thumbprint must match its advertised `kid`
 * (when present). Failures return an empty key set — fail closed.
 */
async function fetchAgentDirectory(
  origin: string,
  cacheTtlSeconds: number,
  fetchImpl: typeof fetch,
): Promise<ResolvedAgentKey[]> {
  const cached = directoryCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  let keys: ResolvedAgentKey[] = [];
  try {
    const response = await fetchImpl(`${origin}${SIGNATURE_AGENT_DIRECTORY_PATH}`, {
      redirect: "error",
      signal: AbortSignal.timeout(DIRECTORY_FETCH_TIMEOUT_MS),
      headers: { accept: "application/http-message-signatures-directory+json" },
    });
    if (response.ok) {
      const body = await readBodyWithCap(response, DIRECTORY_MAX_BYTES);
      const parsed: unknown = body === null ? null : JSON.parse(body);
      keys = await parseDirectoryJwks(parsed);
    }
  } catch {
    keys = [];
  }

  directoryCache.set(origin, { keys, expiresAt: Date.now() + cacheTtlSeconds * 1000 });
  return keys;
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) return null;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

/** Parse a JWKS payload into Ed25519 keys keyed by thumbprint. Invalid entries are dropped. */
export async function parseDirectoryJwks(parsed: unknown): Promise<ResolvedAgentKey[]> {
  if (!parsed || typeof parsed !== "object") return [];
  const rawKeys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(rawKeys)) return [];

  const keys: ResolvedAgentKey[] = [];
  for (const entry of rawKeys) {
    if (!entry || typeof entry !== "object") continue;
    const jwk = entry as { kty?: unknown; crv?: unknown; x?: unknown; kid?: unknown };
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") continue;
    const thumbprint = await ed25519JwkThumbprint(jwk.x);
    // A directory advertising a kid that is not the key's thumbprint is
    // malformed per the directory draft — drop the entry.
    if (typeof jwk.kid === "string" && jwk.kid !== thumbprint) continue;
    keys.push({ keyId: thumbprint, x: jwk.x, agent: null });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

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
    let key = await resolveStaticKey(options.keys, keyid);
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
