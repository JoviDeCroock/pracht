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

const HOST_PREFIX = "__Host-";
const SECURE_PREFIX = "__Secure-";

/**
 * The practical per-cookie ceiling in every current browser: 4096 bytes for
 * the whole `name=value; attributes` string. Over it, browsers do not error —
 * they silently drop the cookie, and the app looks like it randomly logs users
 * out. {@link assertCookieSize} converts that into a thrown error at the point
 * the oversized cookie is created.
 */
export const MAX_COOKIE_BYTES = 4096;

/**
 * How many same-named cookies {@link readCookies} will hand back. A browser
 * sends every cookie whose domain and path match, so an attacker who can write
 * a cookie on a parent domain can send a second `session` alongside the real
 * one. Trying each candidate is the fix; trying an unbounded number of them is
 * a way to make one request perform hundreds of AES-GCM opens.
 */
const MAX_COOKIE_CANDIDATES = 8;

export type SameSite = "Lax" | "Strict" | "None";

export interface ResolvedCookieOptions {
  domain: string | undefined;
  httpOnly: boolean;
  maxAge: number;
  name: string;
  path: string;
  sameSite: SameSite;
  /** `true`/`false` pin the attribute; `undefined` means "infer per request". */
  secure: boolean | undefined;
}

export interface CookieOptionsInput {
  /**
   * Cookie name. Default: `"pracht_session"`.
   *
   * Prefer a `__Host-` prefix (`"__Host-session"`). It is enforced by the
   * browser, not by the server: a `__Host-` cookie is rejected unless it is
   * `Secure`, `Path=/`, and **host-only**, which is exactly what stops a
   * sibling subdomain — or anything that has taken one over — from writing a
   * cookie your app will read. `createSessionStorage()` validates the same
   * rules up front so the mistake surfaces at boot instead of as a cookie the
   * browser silently discards.
   */
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
   * Add the `Secure` attribute.
   *
   * Default: **on**, except for a request whose host is plainly local
   * (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) over http. This fails
   * closed on purpose: a production app behind a TLS-terminating proxy sees
   * `http://` in `request.url` unless the adapter is configured to trust the
   * forwarding headers, and inferring "not https, so not Secure" from that
   * would drop the attribute on exactly the deployments that need it most.
   *
   * Set it to `false` only for http development on a non-localhost host. It
   * cannot be `false` for a `__Host-`/`__Secure-` cookie or with
   * `sameSite: "None"`, because the browser would reject the result.
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

  // Browser-enforced name prefixes. Getting these wrong produces a cookie the
  // browser drops without a word, which reads to the developer as "sessions
  // randomly do not persist" — so validate them here.
  const hostPrefixed = name.startsWith(HOST_PREFIX);
  const securePrefixed = name.startsWith(SECURE_PREFIX);
  if (hostPrefixed) {
    if (domain !== undefined) {
      throw new TypeError(
        `createSessionStorage: a "${HOST_PREFIX}" cookie must be host-only, but a domain ` +
          `("${domain}") was configured. Drop \`cookie.domain\`, or drop the prefix.`,
      );
    }
    if (path !== "/") {
      throw new TypeError(
        `createSessionStorage: a "${HOST_PREFIX}" cookie must use \`path: "/"\`, got "${path}".`,
      );
    }
  }
  if ((hostPrefixed || securePrefixed) && options.secure === false) {
    throw new TypeError(
      `createSessionStorage: a "${hostPrefixed ? HOST_PREFIX : SECURE_PREFIX}" cookie is ` +
        "rejected by the browser without the Secure attribute, so `cookie.secure: false` " +
        "cannot be honoured. Use an unprefixed name for plain-http development.",
    );
  }
  if (sameSite === "None" && options.secure === false) {
    throw new TypeError(
      'createSessionStorage: `sameSite: "None"` is rejected by the browser without the ' +
        "Secure attribute, so `cookie.secure: false` cannot be honoured.",
    );
  }

  // A prefixed name or SameSite=None pins Secure on: there is no request for
  // which the browser would accept the alternative, localhost included.
  const secure = hostPrefixed || securePrefixed || sameSite === "None" ? true : options.secure;

  return { domain, httpOnly: options.httpOnly ?? true, maxAge, name, path, sameSite, secure };
}

/**
 * Every value sent under `name`, in header order.
 *
 * A browser sends one `Cookie` header containing every cookie whose domain and
 * path match, and nothing stops two of them sharing a name — `example.com` and
 * `.example.com` can both hold a `session`. The ordering between them is not
 * something the server can rely on, so taking the first match lets whoever
 * planted the second one decide which session the request runs as (or, with a
 * junk value, deny the real one). The caller tries each candidate instead.
 *
 * Malformed pairs are skipped. The result is capped at
 * {@link MAX_COOKIE_CANDIDATES} so a header stuffed with duplicates cannot
 * turn one request into hundreds of decrypt attempts.
 */
export function readCookies(header: string | null | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(";")) {
    if (values.length >= MAX_COOKIE_CANDIDATES) break;
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() !== name) continue;
    const raw = pair.slice(equals + 1).trim();
    if (raw.length === 0) continue;
    try {
      values.push(decodeURIComponent(raw));
    } catch {
      values.push(raw);
    }
  }
  return values;
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
  // `resolveCookieOptions` has already pinned `cookie.secure` to `true` for
  // the cases the browser would otherwise reject outright.
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

/**
 * Whether a request came from a host where plain http is a development
 * reality rather than a downgrade — the only case in which the `Secure`
 * attribute is dropped automatically.
 */
export function isLocalHttpRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}
