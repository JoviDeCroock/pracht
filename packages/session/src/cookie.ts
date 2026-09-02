/**
 * Cookie parsing and serialization.
 *
 * Attribute values are validated at `createSessionStorage()` time rather than
 * escaped at serialization time: a `;` smuggled into a `Path` or `Domain` adds
 * an attacker-chosen attribute to the `Set-Cookie` header, and a CR/LF splits
 * the response. Both are configuration mistakes, so they should fail loudly on
 * the first boot instead of silently on one request.
 */

const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Semicolons/commas/whitespace or anything outside printable ASCII in an
// attribute value could smuggle extra cookie attributes or split the header.
const COOKIE_ATTRIBUTE_UNSAFE = /[;,\s]|[^ -~]/;

/**
 * The practical per-cookie ceiling in every current browser: 4096 bytes for
 * the whole `name=value; attributes` string. Over it, browsers do not error —
 * they silently drop the cookie, and the app looks like it randomly logs users
 * out. {@link assertCookieSize} converts that into a thrown error at the point
 * the oversized cookie is created.
 */
export const MAX_COOKIE_BYTES = 4096;

export type SameSite = "Lax" | "Strict" | "None";

export interface ResolvedCookieOptions {
  domain: string | undefined;
  httpOnly: boolean;
  maxAge: number;
  name: string;
  path: string;
  sameSite: SameSite;
  secure: boolean | undefined;
}

export interface CookieOptionsInput {
  /** Cookie name. Default: `"pracht_session"`. */
  name?: string;
  /**
   * Signing/encryption secrets, newest first. The first one seals new cookies;
   * every one of them is tried when opening an existing cookie, which is what
   * makes rotation a deploy rather than a mass logout. At least one is
   * required and each must be at least 16 characters.
   */
  secrets: readonly string[];
  /**
   * `Max-Age` in seconds, and the lifetime embedded in the sealed payload.
   * Default: one week.
   */
  maxAge?: number;
  /** Cookie `Path`. Default: `"/"`. */
  path?: string;
  /** Optional cookie `Domain`. Omitted by default (host-only cookie). */
  domain?: string;
  /** `SameSite` attribute. Default: `"Lax"`. */
  sameSite?: SameSite;
  /**
   * Add the `Secure` attribute. Default: automatic — set when the request the
   * session was read from is https, and always when `sameSite` is `"None"`.
   * Set it to `true` explicitly when TLS terminates upstream, because the
   * request URL the app sees is then plain http.
   */
  secure?: boolean;
  /**
   * `HttpOnly`. Default: `true`, and there is no good reason to change it —
   * a session cookie readable from JavaScript is an XSS away from being
   * exfiltrated.
   */
  httpOnly?: boolean;
}

export function resolveCookieOptions(options: CookieOptionsInput): ResolvedCookieOptions {
  const name = options.name ?? "pracht_session";
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new TypeError(`createSessionStorage: invalid cookie name "${name}".`);
  }

  const secrets = options.secrets;
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new TypeError(
      "createSessionStorage: `cookie.secrets` must contain at least one secret. " +
        "Generate one with `openssl rand -base64 32` and read it from the environment.",
    );
  }
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 16) {
      throw new TypeError(
        "createSessionStorage: every entry in `cookie.secrets` must be a string of at least " +
          "16 characters. A short secret is brute-forceable offline from a single stolen cookie.",
      );
    }
  }

  const maxAge = options.maxAge ?? 60 * 60 * 24 * 7;
  if (!Number.isInteger(maxAge) || maxAge <= 0) {
    throw new TypeError("createSessionStorage: cookie `maxAge` must be a positive integer.");
  }

  const path = options.path ?? "/";
  if (!path.startsWith("/") || COOKIE_ATTRIBUTE_UNSAFE.test(path)) {
    throw new TypeError(`createSessionStorage: invalid cookie path "${path}".`);
  }

  const domain = options.domain;
  if (domain !== undefined && (domain.length === 0 || COOKIE_ATTRIBUTE_UNSAFE.test(domain))) {
    throw new TypeError(`createSessionStorage: invalid cookie domain "${domain}".`);
  }

  const sameSite = options.sameSite ?? "Lax";
  if (sameSite !== "Lax" && sameSite !== "Strict" && sameSite !== "None") {
    throw new TypeError(
      `createSessionStorage: invalid sameSite "${String(sameSite)}". Use "Lax", "Strict", or "None".`,
    );
  }

  return {
    domain,
    httpOnly: options.httpOnly ?? true,
    maxAge,
    name,
    path,
    sameSite,
    secure: options.secure,
  };
}

/** Read one cookie value from a `Cookie` header; malformed pairs are skipped. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() !== name) continue;
    const raw = pair.slice(equals + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export interface SerializeCookieOptions {
  cookie: ResolvedCookieOptions;
  /** Seconds until expiry; `0` produces an immediately-expiring cookie. */
  maxAge: number;
  secure: boolean;
  value: string;
}

export function serializeCookie(options: SerializeCookieOptions): string {
  const { cookie, maxAge, secure, value } = options;
  const attributes = [
    `${cookie.name}=${encodeURIComponent(value)}`,
    `Path=${cookie.path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${cookie.sameSite}`,
  ];
  if (cookie.domain !== undefined) attributes.push(`Domain=${cookie.domain}`);
  if (cookie.httpOnly) attributes.push("HttpOnly");
  // Browsers reject `SameSite=None` without `Secure`, so an explicit `false`
  // there would produce a cookie that silently never persists.
  if (secure || cookie.sameSite === "None") attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * Refuse to emit a cookie the browser would silently drop. The message names
 * the fix rather than the limit, because the fix is always the same one.
 */
export function assertCookieSize(header: string, cookieName: string): void {
  // Cookie headers are ASCII after percent-encoding, so length is byte length.
  if (header.length <= MAX_COOKIE_BYTES) return;
  throw new RangeError(
    `@pracht/session: the "${cookieName}" cookie is ${header.length} bytes, over the ` +
      `${MAX_COOKIE_BYTES}-byte limit browsers enforce by silently dropping the cookie. ` +
      "Store less in the session, or pass a `store` to createSessionStorage() so the " +
      "cookie carries only a session id.",
  );
}
