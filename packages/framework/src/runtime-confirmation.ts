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
 * True single-use requires shared storage; the optional in-memory cache below
 * is best effort and per-instance only (documented in docs/AGENT_TRUST.md).
 *
 * The secret comes from `PRACHT_CONFIRMATION_SECRET` or
 * `setCapabilityConfirmationSecret()` — never from the app manifest, which is
 * bundled into the client.
 */

export const CONFIRMATION_HEADER = "x-pracht-confirm";
export const CONFIRMATION_SECRET_ENV = "PRACHT_CONFIRMATION_SECRET";
export const DEFAULT_CONFIRMATION_TTL_SECONDS = 120;

const TOKEN_VERSION = "v1";

const encoder = new TextEncoder();

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
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const secret = env?.[CONFIRMATION_SECRET_ENV];
  return typeof secret === "string" && secret !== "" ? secret : null;
}

/**
 * Deterministic JSON with lexicographically sorted object keys, so the same
 * logical input always canonicalizes to the same bytes regardless of the
 * caller's property order. Input has already passed JSON.parse + schema
 * validation, so only JSON-representable values reach this.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
  return `{${entries.join(",")}}`;
}

interface ConfirmationClaims {
  /** Principal the token is bound to (verified agent key id, or "anonymous"). */
  p: string;
  /** Capability name. */
  c: string;
  /** Base64url SHA-256 of the canonicalized validated input. */
  i: string;
  /** Unix seconds expiry. */
  exp: number;
}

export interface ConfirmationBinding {
  secret: string;
  principal: string;
  capability: string;
  canonicalInput: string;
  now?: number;
}

export async function createConfirmationToken(
  binding: ConfirmationBinding & { ttlSeconds: number },
): Promise<{ token: string; expiresAt: number }> {
  const now = binding.now ?? Math.floor(Date.now() / 1000);
  const claims: ConfirmationClaims = {
    p: binding.principal,
    c: binding.capability,
    i: await sha256Base64Url(binding.canonicalInput),
    exp: now + binding.ttlSeconds,
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacSign(binding.secret, `${TOKEN_VERSION}.${payload}`);
  return { token: `${TOKEN_VERSION}.${payload}.${signature}`, expiresAt: claims.exp };
}

export type ConfirmationFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "principal_mismatch"
  | "capability_mismatch"
  | "input_mismatch"
  | "already_used";

export type ConfirmationVerification =
  | { ok: true; signature: string; expiresAt: number }
  | { ok: false; reason: ConfirmationFailure };

/**
 * Verify a presented confirmation token against the current call. The
 * signature is checked first so nothing later in the pipeline trusts
 * attacker-controlled claims.
 */
export async function verifyConfirmationToken(
  token: string,
  binding: ConfirmationBinding,
): Promise<ConfirmationVerification> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const [, payload, signature] = parts;

  const expected = await hmacSign(binding.secret, `${TOKEN_VERSION}.${payload}`);
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: ConfirmationClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as ConfirmationClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || typeof claims.i !== "string") {
    return { ok: false, reason: "malformed" };
  }

  const now = binding.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp < now) return { ok: false, reason: "expired" };
  if (claims.p !== binding.principal) return { ok: false, reason: "principal_mismatch" };
  if (claims.c !== binding.capability) return { ok: false, reason: "capability_mismatch" };
  if (claims.i !== (await sha256Base64Url(binding.canonicalInput))) {
    return { ok: false, reason: "input_mismatch" };
  }

  return { ok: true, signature, expiresAt: claims.exp };
}

// ---------------------------------------------------------------------------
// Optional best-effort single-use cache (per-instance, in-memory)
// ---------------------------------------------------------------------------

const usedTokens = new Map<string, number>();

/**
 * Mark a token as used. Returns false when it was already consumed on this
 * instance. Expired entries are swept opportunistically so the map cannot
 * grow past the confirmation TTL's working set.
 */
export function consumeConfirmationToken(signature: string, expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (usedTokens.size > 0) {
    for (const [used, expiry] of usedTokens) {
      if (expiry < now) usedTokens.delete(used);
    }
  }
  if (usedTokens.has(signature)) return false;
  usedTokens.set(signature, expiresAt);
  return true;
}

/** Test hook — clears the single-use cache. */
export function clearConsumedConfirmationTokens(): void {
  usedTokens.clear();
}

// ---------------------------------------------------------------------------
// WebCrypto helpers
// ---------------------------------------------------------------------------

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Constant-time comparison of two base64url strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
