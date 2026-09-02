import { fromBase64Url, timingSafeEqual, toBase64Url, utf8 } from "./crypto.ts";

/**
 * Password hashing with PBKDF2-HMAC-SHA256, the only password KDF WebCrypto
 * exposes and therefore the only one that runs unchanged on Node, Cloudflare
 * Workers, Netlify, and Vercel.
 *
 * It is here because the alternative, empirically, is a hand-rolled
 * `SHA-256(password)` in `src/server/auth.ts` — which is not password hashing
 * at all. Argon2id and scrypt are better primitives; reach for them (through
 * a native module, a WASM build, or an identity provider) when the runtime
 * allows it. PBKDF2 with a high iteration count is the correct answer when it
 * does not.
 */

const ALGORITHM = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BITS = 256;

/**
 * Default iteration count. OWASP's PBKDF2-HMAC-SHA256 guidance is higher
 * still, and the right number is the largest one your login latency budget
 * tolerates — measure it.
 *
 * Note for Cloudflare Workers: PBKDF2 burns CPU time, which is the metered
 * and capped resource there. Verify a login against your plan's CPU limit
 * before deploying, and lower `iterations` (or move hashing to a service) if
 * it does not fit.
 */
export const DEFAULT_PASSWORD_ITERATIONS = 210_000;

export interface HashPasswordOptions {
  /** PBKDF2 iterations. Default: {@link DEFAULT_PASSWORD_ITERATIONS}. */
  iterations?: number;
}

/**
 * Hash a password for storage. The returned string is self-describing —
 * `pbkdf2-sha256$<iterations>$<salt>$<hash>` — so raising the iteration count
 * later does not invalidate existing hashes: {@link verifyPassword} reads the
 * parameters out of the stored value.
 *
 * ```ts
 * await db.users.insert({ email, passwordHash: await hashPassword(password) });
 * ```
 */
export async function hashPassword(
  password: string,
  options: HashPasswordOptions = {},
): Promise<string> {
  const iterations = options.iterations ?? DEFAULT_PASSWORD_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1000) {
    throw new TypeError("hashPassword: `iterations` must be an integer of at least 1000.");
  }
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * Check a password against a stored hash. Returns `false` for a wrong
 * password and for a malformed or unknown-algorithm stored value — never
 * throws, so a corrupted row cannot turn into a 500 on the login path.
 *
 * The comparison is constant-time: a byte-by-byte `===` on the derived hash
 * leaks how much of it matched, which is enough to reconstruct it one byte at
 * a time against an attacker-chosen salt.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;

  const salt = fromBase64Url(parts[2]);
  if (salt === null || salt.length === 0) return false;

  const expected = parts[3];
  const actual = toBase64Url(await derive(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}
