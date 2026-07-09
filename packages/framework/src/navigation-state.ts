/**
 * Shared reactive store for the current client navigation / form submission.
 *
 * The client router (`router.ts`) and `<Form>` (`runtime-hooks.ts`) write to
 * this store; `useNavigation()` subscribes to it. The store lives in its own
 * module so both writers can import it without creating a cycle, and so it
 * stays safe to import during SSR (no `window` access at module scope).
 */

export interface NavigationLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

export type Navigation =
  | { state: "idle"; location?: undefined; formData?: undefined }
  | { state: "loading"; location: NavigationLocation; formData?: undefined }
  | { state: "submitting"; location: NavigationLocation; formData: FormData };

export const IDLE_NAVIGATION: Navigation = { state: "idle" };

type NavigationListener = (navigation: Navigation) => void;

let currentNavigation: Navigation = IDLE_NAVIGATION;
let navigationToken = 0;
const listeners = new Set<NavigationListener>();

export function getNavigation(): Navigation {
  return currentNavigation;
}

export function subscribeToNavigation(listener: NavigationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  // Snapshot so listeners that unsubscribe during emit don't affect iteration.
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) {
    listener(currentNavigation);
  }
}

/**
 * Mark a navigation as in-flight. Returns a token that must be passed to
 * `settleNavigation()` — settling is a no-op when a newer navigation or
 * submission has started in the meantime, so superseded navigations never
 * stomp the state of the one that replaced them.
 */
export function beginLoadingNavigation(location: NavigationLocation): number {
  currentNavigation = { state: "loading", location };
  emit();
  return ++navigationToken;
}

export function beginSubmittingNavigation(
  location: NavigationLocation,
  formData: FormData,
): number {
  currentNavigation = { state: "submitting", location, formData };
  emit();
  return ++navigationToken;
}

export function settleNavigation(token: number): void {
  if (token !== navigationToken) return;
  if (currentNavigation.state === "idle") return;
  currentNavigation = IDLE_NAVIGATION;
  emit();
}

/**
 * Parse a navigation target (relative or absolute) into the location shape
 * exposed through `useNavigation()`.
 */
export function createNavigationLocation(url: string): NavigationLocation {
  const base = typeof window !== "undefined" ? window.location.href : "http://pracht.local";
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return { hash: "", href: url, pathname: url, search: "" };
  }
  return {
    hash: parsed.hash,
    href: parsed.pathname + parsed.search + parsed.hash,
    pathname: parsed.pathname,
    search: parsed.search,
  };
}

/** @internal Reset module state for tests. */
export function _resetNavigationForTesting(): void {
  currentNavigation = IDLE_NAVIGATION;
  navigationToken = 0;
  listeners.clear();
}
