/**
 * The cryptography behind a session cookie. WebCrypto only — `crypto.subtle`
 * and `crypto.getRandomValues` are the entire platform surface, so the same
 * build runs on Node, Cloudflare Workers, Netlify, Vercel, and Deno.
 *
 * A sealed value is `v1.<base64url(iv ‖ ciphertext ‖ tag)>`:
 *
 * - **AES-256-GCM**, so the payload is both encrypted and authenticated. A
 *   signed-but-readable cookie leaks whatever the app put in it to anyone who
 *   can read the browser's cookie jar (extensions, shared machines, exported
 *   HAR files, an XSS that survives `HttpOnly` on a subdomain), and every
 *   pracht app that hand-rolled this before put the user id and email in
 *   plaintext base64.
 * - The **key is derived from the configured secret with HKDF-SHA256** rather
 *   than used directly, so a secret does not have to be exactly 32 bytes and
 *   the same secret can never collide with an unrelated use of it elsewhere
 *   in the app (the `info` string binds the derivation to this package).
 * - The **IV is 12 random bytes per seal**, which is the size AES-GCM is
 *   specified for and the size every runtime's implementation is fastest at.
 *
 * Rotation is handled by trying every configured key on open, newest first.
 * That is deliberately *not* a key id in the token: an id would tell an
 * attacker which secret to attack, and the number of secrets is small enough
 * that trying them all costs nothing measurable.
 */

/** Salt and info for HKDF. Constants, not secrets — they scope the key. */
const HKDF_SALT = "pracht.session.hkdf.v1";
const HKDF_INFO = "pracht.session.aes-gcm.v1";

/** Version prefix, so the format can change without silently mis-decrypting. */
const TOKEN_VERSION = "v1";

const IV_BYTES = 12;

/**
 * WebCrypto's `BufferSource` is `ArrayBufferView<ArrayBuffer>`, so a plain
 * `Uint8Array` (whose buffer may be a `SharedArrayBuffer`) is not assignable
 * to it. Naming the backing buffer once keeps every call site clean.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

export function utf8(value: string): Bytes {
  return encoder.encode(value);
}

/**
 * Base64url without padding. `btoa`/`atob` are available on every runtime this
 * package targets, and going through them keeps the package free of
 * `node:buffer`.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large payload cannot blow the argument limit of `apply`.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Inverse of {@link toBase64Url}; returns `null` for anything malformed. */
export function fromBase64Url(value: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Compare two strings without leaking their common prefix length through
 * timing. Used for the cookie-name binding inside a sealed payload: AES-GCM
 * already authenticates the bytes, but the binding check is application-level
 * and an attacker who can replay sealed values across cookie names would
 * otherwise get a free oracle for it.
 *
 * The length is compared up front on purpose — it is not secret (it is the
 * configured cookie name's length), and folding it into the loop would mean
 * indexing past the end of the shorter string.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** A cryptographically random id, base64url-encoded. */
export function randomId(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

/**
 * Derive one AES-GCM key per secret, once. Derivation is not free (HKDF is two
 * HMACs plus an import) and a session is read on every request, so the promise
 * is cached rather than the key: concurrent first requests share one
 * derivation instead of racing.
 */
export function createKeyring(secrets: readonly string[]): Keyring {
  const cache = new Map<number, Promise<CryptoKey>>();

  function keyAt(index: number): Promise<CryptoKey> {
    let key = cache.get(index);
    if (!key) {
      key = deriveKey(secrets[index]);
      // A failed derivation must not be memoized as a permanently rejected
      // promise — the next request should get a real error, not this one.
      key.catch(() => cache.delete(index));
      cache.set(index, key);
    }
    return key;
  }

  return {
    async seal(plaintext: string): Promise<string> {
      const key = await keyAt(0);
      const iv = new Uint8Array(IV_BYTES);
      crypto.getRandomValues(iv);
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext)),
      );
      const token = new Uint8Array(iv.length + ciphertext.length);
      token.set(iv, 0);
      token.set(ciphertext, iv.length);
      return `${TOKEN_VERSION}.${toBase64Url(token)}`;
    },

    async open(token: string): Promise<string | null> {
      const separator = token.indexOf(".");
      if (separator === -1) return null;
      if (token.slice(0, separator) !== TOKEN_VERSION) return null;
      const bytes = fromBase64Url(token.slice(separator + 1));
      if (bytes === null || bytes.length <= IV_BYTES) return null;

      const iv = bytes.subarray(0, IV_BYTES);
      const ciphertext = bytes.subarray(IV_BYTES);
      for (let index = 0; index < secrets.length; index += 1) {
        try {
          const key = await keyAt(index);
          const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
          return decoder.decode(plaintext);
        } catch {
          // Wrong key, tampered ciphertext, or truncated tag — all
          // indistinguishable by design. Try the next secret; exhausting them
          // is the same answer as a forged cookie: no session.
        }
      }
      return null;
    },
  };
}

export interface Keyring {
  seal(plaintext: string): Promise<string>;
  open(token: string): Promise<string | null>;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(HKDF_SALT), info: utf8(HKDF_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
