import {
  assertCookieSize,
  type CookieOptionsInput,
  readCookie,
  type ResolvedCookieOptions,
  resolveCookieOptions,
  serializeCookie,
} from "./cookie.ts";
import { createKeyring, type Keyring, randomId, timingSafeEqual } from "./crypto.ts";
import type { SessionStore } from "./store.ts";

/** Keys an app may address on its session data. */
type Key<Data> = Extract<keyof Data, string>;

/**
 * One user's session for one request.
 *
 * Every member is a closure, not a method on a prototype: the session is
 * routinely parked on `context`, and adapters are free to hand application
 * code a frozen context or an overlay proxy. Class private fields would bind
 * to the original receiver and break there; plain closures cannot.
 */
export interface Session<Data extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Stable random 128-bit id for this session. With a `store` it is the
   * storage key; without one it is still useful as a log correlation id and as
   * the seed for a per-session CSRF token.
   */
  readonly id: string;
  /**
   * Snapshot of everything currently in the session. Reading it does **not**
   * consume flash values — use `get()` for that. Mutating the returned object
   * has no effect; use `set()`.
   */
  readonly data: Readonly<Partial<Data>>;
  /**
   * Read a value. If the key was written with `flash()`, this is the read that
   * consumes it: it is returned once and gone from the next commit.
   */
  get<K extends Key<Data>>(key: K): Data[K] | undefined;
  set<K extends Key<Data>>(key: K, value: Data[K]): void;
  unset(key: Key<Data>): void;
  /** Presence check that never consumes a flash value. */
  has(key: Key<Data>): boolean;
  /**
   * Write a value that survives exactly until it is read once — the pattern
   * behind "your changes were saved" surviving a redirect. Flashing over an
   * existing plain value replaces it and makes it single-read.
   */
  flash<K extends Key<Data>>(key: K, value: Data[K]): void;
}

export interface CommitOptions {
  /**
   * Override the configured `maxAge` for this commit, in seconds — the
   * "remember me" checkbox. Applies to both the cookie attribute and the
   * expiry sealed into the payload.
   */
  maxAge?: number;
}

export interface SessionStorage<Data extends Record<string, unknown> = Record<string, unknown>> {
  /** The cookie name in use. */
  readonly cookieName: string;
  /**
   * Load the session for a request. Never throws on a bad cookie: a forged,
   * tampered, expired, or unknown-to-the-store cookie yields a fresh empty
   * session, exactly as if the browser had sent nothing.
   *
   * Accepts a `Request`, a raw `Cookie` header, or `null`/`undefined` for a
   * brand-new session.
   */
  getSession(source?: Request | string | null): Promise<Session<Data>>;
  /**
   * Seal the session and return the `Set-Cookie` **value**. Call it after
   * mutating the session and put the result on the response yourself — or let
   * {@link SessionStorage.commit} do that part.
   */
  commitSession(session: Session<Data>, options?: CommitOptions): Promise<string>;
  /**
   * Append the committed `Set-Cookie` to a response and return it. Existing
   * `Set-Cookie` headers are preserved — the header is appended, never
   * replaced — and a response whose headers are immutable is reconstructed
   * rather than mutated in place.
   */
  commit(session: Session<Data>, response: Response, options?: CommitOptions): Promise<Response>;
  /**
   * Drop the session: delete it from the store (when there is one) and return
   * an immediately-expiring `Set-Cookie` value. The passed session is emptied,
   * so anything downstream still holding it sees a logged-out user.
   */
  destroySession(session: Session<Data>): Promise<string>;
  /** {@link SessionStorage.destroySession} applied to a response. */
  destroy(session: Session<Data>, response: Response): Promise<Response>;
  /**
   * `true` when the session changed during this request and therefore needs a
   * `Set-Cookie`. A read-only request returns `false`, which is what keeps
   * {@link sessionMiddleware} from putting a `Set-Cookie` on every response.
   */
  isDirty(session: Session<Data>): boolean;
}

export interface SessionStorageOptions {
  cookie: CookieOptionsInput;
  /**
   * Where the session data lives. Omitted, the (encrypted) data travels in the
   * cookie itself — no infrastructure, but a 4 KB ceiling and no server-side
   * logout. Provided, the cookie carries only a sealed session id.
   */
  store?: SessionStore;
}

/**
 * Context field {@link sessionMiddleware} populates. Merge it into the app's
 * registered context so loaders, API routes, and capabilities see
 * `context.session` without a cast:
 *
 * ```ts
 * // src/env.d.ts
 * import type { SessionRequestContext } from "@pracht/session";
 *
 * declare module "@pracht/core" {
 *   interface Register {
 *     context: SessionRequestContext<{ userId: string }>;
 *   }
 * }
 * ```
 */
export interface SessionRequestContext<
  Data extends Record<string, unknown> = Record<string, unknown>,
> {
  session: Session<Data>;
}

/** What travels inside the sealed cookie. Short keys — it is size-constrained. */
interface Envelope {
  /** Cookie name this payload was sealed for. */
  n: string;
  /** Session id. */
  i: string;
  /** Absolute expiry, `Date.now()` milliseconds. */
  e: number;
  /** Session data — cookie sessions only; store sessions keep it server-side. */
  d?: Record<string, unknown>;
  /** Keys whose value is consumed on the next read. */
  f?: string[];
}

interface SessionState {
  data: Record<string, unknown>;
  destroyed: boolean;
  dirty: boolean;
  flash: Set<string>;
  /** Inferred from the request the session was read from; see `cookie.secure`. */
  secure: boolean;
}

/**
 * Create the app's session storage. Define it once in a shared module and
 * import it from the middleware, the login/logout API routes, and anywhere
 * else that reads a session outside the middleware chain.
 *
 * ```ts
 * // src/server/session.ts
 * import { serverEnv } from "@pracht/core/env/server";
 * import { createSessionStorage } from "@pracht/session";
 *
 * export const sessions = createSessionStorage<{ userId: string; email: string }>({
 *   cookie: { name: "session", secrets: [serverEnv.SESSION_SECRET] },
 * });
 * ```
 *
 * On Cloudflare Workers, env bindings only exist per request — build the
 * storage from a memoized getter called inside middleware/loaders rather than
 * at module top level.
 */
export function createSessionStorage<
  Data extends Record<string, unknown> = Record<string, unknown>,
>(options: SessionStorageOptions): SessionStorage<Data> {
  const cookie: ResolvedCookieOptions = resolveCookieOptions(options.cookie);
  const store = options.store;
  const keyring: Keyring = createKeyring(options.cookie.secrets);

  // Sessions are handed to application code, so the bookkeeping lives beside
  // them rather than on them: nothing an app can serialize, log, or pass to a
  // component carries the dirty flag or the store binding, and a session from
  // a *different* storage is rejected instead of silently half-working.
  const states = new WeakMap<Session<Data>, SessionState>();

  function stateOf(session: Session<Data>): SessionState {
    const state = states.get(session);
    if (!state) {
      throw new TypeError(
        "@pracht/session: this session was not created by this storage. Pass the session " +
          "returned by the same createSessionStorage() instance's getSession().",
      );
    }
    return state;
  }

  function makeSession(
    id: string,
    data: Record<string, unknown>,
    flash: Set<string>,
    secure: boolean,
  ): Session<Data> {
    const state: SessionState = { data, destroyed: false, dirty: false, flash, secure };

    const session: Session<Data> = {
      id,
      get data() {
        return { ...state.data } as Readonly<Partial<Data>>;
      },
      get<K extends Key<Data>>(key: K): Data[K] | undefined {
        const value = state.data[key];
        if (state.flash.has(key)) {
          state.flash.delete(key);
          delete state.data[key];
          state.dirty = true;
        }
        return value as Data[K] | undefined;
      },
      set<K extends Key<Data>>(key: K, value: Data[K]): void {
        state.data[key] = value;
        // A key stops being a flash key when it is written normally.
        state.flash.delete(key);
        state.dirty = true;
      },
      unset(key: Key<Data>): void {
        if (!(key in state.data) && !state.flash.has(key)) return;
        delete state.data[key];
        state.flash.delete(key);
        state.dirty = true;
      },
      has(key: Key<Data>): boolean {
        return key in state.data;
      },
      flash<K extends Key<Data>>(key: K, value: Data[K]): void {
        state.data[key] = value;
        state.flash.add(key);
        state.dirty = true;
      },
    };

    states.set(session, state);
    return session;
  }

  function emptySession(secure: boolean): Session<Data> {
    return makeSession(randomId(), emptyData(), new Set(), secure);
  }

  async function readEnvelope(header: string | null): Promise<Envelope | null> {
    const raw = readCookie(header, cookie.name);
    if (raw === null || raw.length === 0) return null;

    const plaintext = await keyring.open(raw);
    if (plaintext === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;

    const { n, i, e } = parsed as Envelope;
    // Bind the payload to the cookie it arrived in, so a value sealed for one
    // cookie of an app cannot be replayed into another that shares the secret.
    if (typeof n !== "string" || !timingSafeEqual(n, cookie.name)) return null;
    if (typeof i !== "string" || i.length === 0) return null;
    // The expiry lives inside the sealed payload, not only in `Max-Age`. The
    // attribute is a request the *client* is free to ignore; only this check
    // actually ends a session.
    if (typeof e !== "number" || !Number.isFinite(e) || e <= Date.now()) return null;

    return parsed as Envelope;
  }

  async function getSession(source?: Request | string | null): Promise<Session<Data>> {
    const header =
      typeof source === "string"
        ? source
        : source instanceof Request
          ? source.headers.get("cookie")
          : null;
    // `secure` is inferred the way @pracht/i18n infers it: https request →
    // Secure cookie, plain http (localhost) → not, explicit option wins.
    const secure = cookie.secure ?? (source instanceof Request ? isHttps(source.url) : false);

    const envelope = await readEnvelope(header);
    if (envelope === null) return emptySession(secure);

    const flash = new Set<string>(Array.isArray(envelope.f) ? envelope.f : []);

    if (store) {
      const record = await store.get(envelope.i);
      // The store is authoritative: a deleted record ends the session even
      // though the browser still holds a perfectly valid cookie.
      if (record === null || typeof record !== "object") return emptySession(secure);
      return makeSession(envelope.i, Object.assign(emptyData(), record), flash, secure);
    }

    const data = envelope.d;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return emptySession(secure);
    }
    return makeSession(envelope.i, Object.assign(emptyData(), data), flash, secure);
  }

  async function commitSession(
    session: Session<Data>,
    commitOptions?: CommitOptions,
  ): Promise<string> {
    const state = stateOf(session);
    const maxAge = resolveMaxAge(commitOptions?.maxAge, cookie.maxAge);

    if (state.destroyed) {
      return serializeCookie({ cookie, maxAge: 0, secure: state.secure, value: "" });
    }

    const expiresAt = Date.now() + maxAge * 1000;
    const envelope: Envelope = { n: cookie.name, i: session.id, e: expiresAt };
    if (state.flash.size > 0) envelope.f = [...state.flash];

    if (store) {
      await store.set(session.id, { ...state.data }, expiresAt);
    } else {
      envelope.d = { ...state.data };
    }

    const value = await keyring.seal(JSON.stringify(envelope));
    const header = serializeCookie({ cookie, maxAge, secure: state.secure, value });
    assertCookieSize(header, cookie.name);
    state.dirty = false;
    return header;
  }

  async function destroySession(session: Session<Data>): Promise<string> {
    const state = stateOf(session);
    if (store) await store.delete(session.id);
    state.data = emptyData();
    state.flash.clear();
    state.destroyed = true;
    state.dirty = false;
    return serializeCookie({ cookie, maxAge: 0, secure: state.secure, value: "" });
  }

  return {
    cookieName: cookie.name,
    getSession,
    commitSession,
    destroySession,
    async commit(session, response, commitOptions) {
      return withSetCookie(response, await commitSession(session, commitOptions));
    },
    async destroy(session, response) {
      return withSetCookie(response, await destroySession(session));
    },
    isDirty(session) {
      return stateOf(session).dirty;
    },
  };
}

/**
 * Null-prototype backing object. The envelope is authenticated, so this is not
 * load-bearing against an attacker — it just means a session key called
 * `toString` or `constructor` behaves like data instead of like a method.
 */
function emptyData(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function resolveMaxAge(override: number | undefined, fallback: number): number {
  if (override === undefined) return fallback;
  if (!Number.isInteger(override) || override <= 0) {
    throw new TypeError("commitSession: `maxAge` must be a positive integer number of seconds.");
  }
  return override;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True for responses that switch protocols instead of carrying a body (a
 * WebSocket `101` handshake). Reconstructing one drops the socket handle and
 * the `Response` constructor rejects sub-200 statuses, so they pass through.
 */
function isProtocolSwitchResponse(response: Response): boolean {
  return response.status < 200 || (response as { webSocket?: unknown }).webSocket != null;
}

/**
 * Append `Set-Cookie` without disturbing any already there — a response may
 * legitimately set a locale cookie, a consent cookie, and a session cookie at
 * once, and `set()` would silently drop the others. Responses from `fetch()`
 * and `Response.redirect()` have immutable headers, so reconstruct rather than
 * throw.
 */
export function withSetCookie(response: Response, header: string): Response {
  if (isProtocolSwitchResponse(response)) return response;
  try {
    response.headers.append("set-cookie", header);
    return response;
  } catch {
    const clone = new Response(response.body, response);
    clone.headers.append("set-cookie", header);
    return clone;
  }
}
