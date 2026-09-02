/**
 * Server-side session storage.
 *
 * With a store, the cookie carries only a sealed 128-bit id and the data lives
 * wherever the app already keeps state. That is the right shape when the
 * session holds more than a few hundred bytes, when logout has to invalidate
 * a session everywhere rather than just in the browser that asked, or when the
 * session data must never leave the server.
 *
 * The interface is three methods on purpose: every production backing store —
 * Cloudflare KV, D1, Redis, Postgres, Durable Objects — implements it in about
 * ten lines, and none of them need to know anything about cookies.
 */
export interface SessionStore {
  /**
   * Return the stored record, or `null` when the id is unknown or expired.
   * Stores with native TTL (KV, Redis) can let the backend do the expiring;
   * stores without one must compare against the `expiresAt` they were given.
   */
  get(id: string): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  /** Persist `data` under `id`. `expiresAt` is a `Date.now()`-style timestamp in ms. */
  set(id: string, data: Record<string, unknown>, expiresAt: number): Promise<void> | void;
  /** Remove the record. Must not throw when the id is already gone. */
  delete(id: string): Promise<void> | void;
}

interface MemoryRecord {
  data: Record<string, unknown>;
  expiresAt: number;
}

/**
 * In-memory reference implementation.
 *
 * Use it for tests, for a single-process dev server, and as the shape to copy
 * when writing a real store. Do **not** use it in production: the sessions die
 * with the process, and nothing is shared between instances — on Cloudflare
 * Workers or any serverless platform that means a user is logged out roughly
 * whenever the platform feels like it.
 */
export function createMemorySessionStore(): SessionStore & { size(): number } {
  const records = new Map<string, MemoryRecord>();

  /**
   * Expired entries are dropped on read rather than on a timer: a timer would
   * hold the process open, and `unref()` is Node-only.
   */
  function live(id: string, now: number): MemoryRecord | null {
    const record = records.get(id);
    if (!record) return null;
    if (record.expiresAt <= now) {
      records.delete(id);
      return null;
    }
    return record;
  }

  return {
    get(id) {
      const record = live(id, Date.now());
      // Hand back a copy: the caller mutates the session object it is given,
      // and a real store would never share the caller's reference either.
      return record ? { ...record.data } : null;
    },
    set(id, data, expiresAt) {
      records.set(id, { data: { ...data }, expiresAt });
    },
    delete(id) {
      records.delete(id);
    },
    /** Live record count, for tests. Not part of {@link SessionStore}. */
    size() {
      const now = Date.now();
      // Deleting the current entry mid-iteration is well-defined for a Map.
      for (const id of records.keys()) live(id, now);
      return records.size;
    },
  };
}
