const STATELESS_TOKEN_VERSION = "v1";
const DURABLE_TOKEN_VERSION = "v2";

const encoder = new TextEncoder();

/**
 * Deterministic JSON with lexicographically sorted object keys, so equivalent
 * validated inputs bind to the same confirmation token bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
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
  /** Approval policy bound into durable (v2) confirmation tokens. */
  m?: CapabilityConfirmationMode;
}

export type CapabilityConfirmationMode = "token" | "human";

export interface ConfirmationBinding {
  secret: string;
  principal: string;
  capability: string;
  canonicalInput: string;
  /** Present when a durable approval store backs this confirmation. */
  approvalMode?: CapabilityConfirmationMode;
  now?: number;
}

export async function createConfirmationToken(
  binding: ConfirmationBinding & { ttlSeconds: number },
): Promise<{ token: string; expiresAt: number }> {
  const now = binding.now ?? Math.floor(Date.now() / 1000);
  const version = confirmationTokenVersion(binding);
  const claims: ConfirmationClaims = {
    p: binding.principal,
    c: binding.capability,
    i: await sha256Base64Url(binding.canonicalInput),
    exp: now + binding.ttlSeconds,
    ...(binding.approvalMode ? { m: binding.approvalMode } : {}),
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacSha256Base64Url(binding.secret, `${version}.${payload}`);
  return { token: `${version}.${payload}.${signature}`, expiresAt: claims.exp };
}

export type ConfirmationFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "principal_mismatch"
  | "capability_mismatch"
  | "input_mismatch"
  | "approval_mode_mismatch"
  | "already_used";

export type ConfirmationVerification =
  | { ok: true; signature: string; expiresAt: number }
  | { ok: false; reason: ConfirmationFailure };

/** Verify the signature before trusting any caller-controlled token claims. */
export async function verifyConfirmationToken(
  token: string,
  binding: ConfirmationBinding,
): Promise<ConfirmationVerification> {
  const parts = token.split(".");
  const version = confirmationTokenVersion(binding);
  if (parts.length !== 3 || parts[0] !== version) {
    return { ok: false, reason: "malformed" };
  }
  const [, payload, signature] = parts;

  const expected = await hmacSha256Base64Url(binding.secret, `${version}.${payload}`);
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
  if (claims.m !== binding.approvalMode) {
    return { ok: false, reason: "approval_mode_mismatch" };
  }
  if (claims.i !== (await sha256Base64Url(binding.canonicalInput))) {
    return { ok: false, reason: "input_mismatch" };
  }

  return { ok: true, signature, expiresAt: claims.exp };
}

export async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
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

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function confirmationTokenVersion(binding: ConfirmationBinding): string {
  return binding.approvalMode ? DURABLE_TOKEN_VERSION : STATELESS_TOKEN_VERSION;
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
