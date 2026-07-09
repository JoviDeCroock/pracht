/**
 * Scroll restoration for the client router.
 *
 * Positions are keyed by a per-history-entry key stored on `history.state`
 * and persisted in `sessionStorage` so they survive full reloads and
 * back-navigation from external documents. The store is bounded (LRU) so a
 * long browsing session cannot grow storage without limit.
 */

export interface ScrollPosition {
  x: number;
  y: number;
}

export interface ScrollPositionStore {
  get(key: string): ScrollPosition | null;
  set(key: string, position: ScrollPosition): void;
}

export type ScrollStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "pracht:scroll-positions";
const MAX_SCROLL_ENTRIES = 50;
export const HISTORY_STATE_KEY = "__prachtScrollKey";

type StoredEntry = [key: string, x: number, y: number];

function readEntries(storage: ScrollStorage | null): StoredEntry[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredEntry =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "number" &&
        typeof entry[2] === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Create a scroll position store backed by the given storage (normally
 * `sessionStorage`). Storage failures (private mode, quota) degrade to an
 * in-memory map for the current page lifetime.
 */
export function createScrollPositionStore(
  storage: ScrollStorage | null,
  maxEntries: number = MAX_SCROLL_ENTRIES,
): ScrollPositionStore {
  const positions = new Map<string, ScrollPosition>();
  for (const [key, x, y] of readEntries(storage)) {
    positions.set(key, { x, y });
  }

  function persist(): void {
    if (!storage) return;
    const entries: StoredEntry[] = [];
    for (const [key, position] of positions) {
      entries.push([key, position.x, position.y]);
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable — keep the in-memory copy.
    }
  }

  return {
    get(key: string): ScrollPosition | null {
      return positions.get(key) ?? null;
    },
    set(key: string, position: ScrollPosition): void {
      // Re-insert so Map iteration order doubles as LRU order.
      positions.delete(key);
      positions.set(key, position);
      while (positions.size > maxEntries) {
        const oldest = positions.keys().next();
        if (oldest.done) break;
        positions.delete(oldest.value);
      }
      persist();
    },
  };
}

export function getSessionScrollStorage(): ScrollStorage | null {
  if (typeof window === "undefined") return null;
  try {
    // Accessing `sessionStorage` itself can throw (e.g. sandboxed iframes).
    const storage = window.sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export function generateScrollKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Read the pracht scroll key from a `history.state` value, if present. */
export function readScrollKeyFromHistoryState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const key = (state as Record<string, unknown>)[HISTORY_STATE_KEY];
  return typeof key === "string" ? key : null;
}

/** Merge the pracht scroll key into an existing `history.state` value. */
export function withScrollKeyInHistoryState(state: unknown, key: string): Record<string, unknown> {
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return { ...(state as Record<string, unknown>), [HISTORY_STATE_KEY]: key };
  }
  return { [HISTORY_STATE_KEY]: key };
}
