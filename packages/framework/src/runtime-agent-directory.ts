import type { WebBotAuthStaticKey } from "./types.ts";

export const SIGNATURE_AGENT_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** Cap on directory response bodies — a JWKS is tiny; anything bigger is hostile. */
const DIRECTORY_MAX_BYTES = 65_536;
const DIRECTORY_FETCH_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();

export interface ResolvedAgentKey {
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

/**
 * RFC 8037 Appendix A.3 JWK thumbprint for an Ed25519 public key: SHA-256
 * over the canonical `{"crv","kty","x"}` JSON, base64url encoded.
 */
export async function ed25519JwkThumbprint(x: string): Promise<string> {
  const canonical = JSON.stringify({ crv: "Ed25519", kty: "OKP", x });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function resolveStaticAgentKey(
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
 * Fetch and parse an agent's key directory with strict transport and size
 * limits. Failures resolve to an empty key set and are cached briefly.
 */
export async function fetchAgentDirectory(
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

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
