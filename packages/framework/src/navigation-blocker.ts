/**
 * Navigation guards for the client router.
 *
 * A pending navigation is a thing you can say no to. Ember modelled this as a
 * first-class transition object with `abort()` and `retry()`, which is what
 * makes "you have unsaved changes" and "re-authenticate, then resume where you
 * were going" expressible at all. Pracht's `useNavigation()` reports that a
 * navigation is in flight but offers no way to stop one.
 *
 * This module owns that state. The client router (`router.ts`) asks it whether
 * to proceed and hands it a retry closure; `useBlocker()` in
 * `runtime-hooks.ts` subscribes to it. It lives in its own module so both
 * sides can import it without a cycle, and so it stays safe to import during
 * SSR (no `window` access at module scope).
 *
 * Traversals are the reason this is more than a boolean. By the time
 * `popstate` fires the URL has already changed, so blocking means putting the
 * entry back — which needs to know how far the browser moved. Every entry the
 * router creates carries a monotonic index in `history.state` for exactly that
 * subtraction.
 */

import { createNavigationLocation, type NavigationLocation } from "./navigation-state.ts";

export const HISTORY_INDEX_KEY = "__prachtHistoryIndex";

/** Mirrors the router's define; see `client: { navigationGuards }`. */
declare const __PRACHT_CLIENT_BLOCKER__: boolean | undefined;

/**
 * The router reaches the guard through a window slot rather than an import, so
 * an app that never renders `useBlocker()` does not carry this store in its
 * client bundle — the same shape as capability revalidation and Suspense
 * hydration tracking, which also hang off the code that uses them.
 *
 * @internal
 */
export type BlockNavigationFn = (
  currentHref: string,
  nextHref: string | null,
  historyAction: BlockerHistoryAction,
  retry: () => void,
) => boolean;

export type BlockerState = "unblocked" | "blocked" | "proceeding";

/**
 * How the navigation being judged was started. `"unload"` is the document
 * itself going away — a reload, a closed tab, or a link to another origin.
 */
export type BlockerHistoryAction = "push" | "replace" | "pop" | "unload";

export interface BlockerArgs {
  currentLocation: NavigationLocation;
  /** `null` for `historyAction: "unload"`: the destination is not ours to know. */
  nextLocation: NavigationLocation | null;
  historyAction: BlockerHistoryAction;
}

export type ShouldBlockNavigation = (args: BlockerArgs) => boolean;

export interface Blocker {
  state: BlockerState;
  /** Where the blocked navigation was going; `null` while unblocked. */
  location: NavigationLocation | null;
  /** Let the blocked navigation continue. No-op unless `state` is `"blocked"`. */
  proceed(): void;
  /** Abandon the blocked navigation and stay put. */
  reset(): void;
}

export interface BlockerSnapshot {
  state: BlockerState;
  location: NavigationLocation | null;
}

export interface RegisterBlockerOptions {
  /**
   * Also guard full document unloads with `beforeunload`. On by default: a
   * guard that lets a reload discard the work it was protecting is not a
   * guard. The browser shows its own dialog for these — the text is not ours
   * to choose.
   */
  beforeUnload?: boolean;
}

interface RegisteredBlocker {
  shouldBlock: ShouldBlockNavigation;
  beforeUnload: boolean;
}

let registered: RegisteredBlocker | null = null;
let state: BlockerState = "unblocked";
let blockedLocation: NavigationLocation | null = null;
let retryBlockedNavigation: (() => void) | null = null;
/**
 * Set by `proceed()` and consumed by the next `shouldBlockNavigation()` call.
 * A flag rather than a state check because the popstate retry (`history.go`)
 * lands asynchronously, so `"proceeding"` cannot be cleared synchronously.
 */
let bypassNextCheck = false;

const listeners = new Set<() => void>();
let beforeUnloadListener: ((event: BeforeUnloadEvent) => void) | null = null;

export function getBlockerSnapshot(): BlockerSnapshot {
  return { state, location: blockedLocation };
}

export function subscribeToBlocker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  // Snapshot so a listener that unsubscribes during emit does not affect iteration.
  for (const listener of Array.from(listeners)) listener();
}

function attachBeforeUnload(): void {
  if (beforeUnloadListener || typeof window === "undefined") return;
  beforeUnloadListener = (event: BeforeUnloadEvent) => {
    if (!registered?.beforeUnload) return;
    const blocks = runShouldBlock({
      currentLocation: createNavigationLocation(window.location.href),
      nextLocation: null,
      historyAction: "unload",
    });
    if (!blocks) return;
    event.preventDefault();
    // Safari and older Chrome still key off the legacy return value.
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnloadListener);
}

function detachBeforeUnload(): void {
  if (!beforeUnloadListener || typeof window === "undefined") return;
  window.removeEventListener("beforeunload", beforeUnloadListener);
  beforeUnloadListener = null;
}

function runShouldBlock(args: BlockerArgs): boolean {
  if (!registered) return false;
  try {
    return registered.shouldBlock(args) === true;
  } catch (error) {
    // A throwing guard must not strand the user on the page they are trying to
    // leave; failing open and saying so loudly is the safer default.
    console.error("[pracht] navigation blocker threw; allowing the navigation.", error);
    return false;
  }
}

/**
 * Register the single active navigation guard. Returns an unregister function.
 *
 * Only one guard is active at a time. Two components each believing they own
 * the guard is a bug worth naming rather than a composition to support, so the
 * newest registration wins and development warns about the overlap.
 */
export function registerBlocker(
  shouldBlock: ShouldBlockNavigation,
  options?: RegisterBlockerOptions,
): () => void {
  if (import.meta.env?.DEV) {
    if (registered) {
      console.warn(
        "[pracht] a second useBlocker() was registered while one was already active. " +
          "Only the most recent guard runs; render at most one at a time.",
      );
    }
    // Compiling the guard checks out leaves `useBlocker()` importable and
    // inert, which for a feature whose job is protecting unsaved work is worth
    // saying out loud rather than leaving to be discovered in production.
    if (typeof __PRACHT_CLIENT_BLOCKER__ !== "undefined" && __PRACHT_CLIENT_BLOCKER__ === false) {
      console.warn(
        "[pracht] useBlocker() will never block: navigation guards are compiled out by " +
          "client: { navigationGuards: false } in the pracht plugin options.",
      );
    }
  }

  const entry: RegisteredBlocker = {
    shouldBlock,
    beforeUnload: options?.beforeUnload !== false,
  };
  registered = entry;
  if (entry.beforeUnload) attachBeforeUnload();
  if (typeof window !== "undefined") {
    window.__PRACHT_BLOCK_NAVIGATION__ ??= shouldBlockNavigation;
  }

  return () => {
    if (registered !== entry) return;
    registered = null;
    detachBeforeUnload();
    // Unmounting the guard while a navigation waits on it would otherwise
    // leave the router holding a retry nobody can trigger.
    if (state !== "unblocked") resetBlockedNavigation();
  };
}

/**
 * Ask the active guard whether to stop this navigation.
 *
 * `retry` is what `proceed()` calls to resume — re-running the navigation for
 * a push or replace, and moving the history cursor back for a traversal the
 * router already undid.
 */
export function shouldBlockNavigation(
  currentHref: string,
  nextHref: string | null,
  historyAction: BlockerHistoryAction,
  retry: () => void,
): boolean {
  if (bypassNextCheck) {
    bypassNextCheck = false;
    if (state !== "unblocked") {
      state = "unblocked";
      blockedLocation = null;
      emit();
    }
    return false;
  }
  // A guard cannot block a second navigation while it is already blocking one:
  // the retry closure it is holding would be replaced and the first
  // destination silently lost.
  if (!registered || state !== "unblocked") return false;

  // Locations are parsed here rather than at the two call sites so the router
  // passes plain hrefs and carries none of this shape in its bundle.
  const nextLocation = nextHref === null ? null : createNavigationLocation(nextHref);
  if (
    !runShouldBlock({
      currentLocation: createNavigationLocation(currentHref),
      nextLocation,
      historyAction,
    })
  ) {
    return false;
  }

  state = "blocked";
  blockedLocation = nextLocation;
  retryBlockedNavigation = retry;
  emit();
  return true;
}

export function proceedBlockedNavigation(): void {
  if (state !== "blocked") return;
  const retry = retryBlockedNavigation;
  retryBlockedNavigation = null;
  state = "proceeding";
  bypassNextCheck = true;
  emit();
  retry?.();
}

export function resetBlockedNavigation(): void {
  if (state === "unblocked") return;
  state = "unblocked";
  blockedLocation = null;
  retryBlockedNavigation = null;
  bypassNextCheck = false;
  emit();
}

/** Read the router's history-entry index from a `history.state` value. */
export function readHistoryIndex(historyState: unknown): number | null {
  if (!historyState || typeof historyState !== "object") return null;
  const index = (historyState as Record<string, unknown>)[HISTORY_INDEX_KEY];
  return typeof index === "number" && Number.isInteger(index) ? index : null;
}

/** Merge the router's history-entry index into an existing `history.state` value. */
export function withHistoryIndex(historyState: unknown, index: number): Record<string, unknown> {
  if (historyState && typeof historyState === "object" && !Array.isArray(historyState)) {
    return { ...(historyState as Record<string, unknown>), [HISTORY_INDEX_KEY]: index };
  }
  return { [HISTORY_INDEX_KEY]: index };
}

/** @internal Reset module state for tests. */
export function _resetBlockerForTesting(): void {
  detachBeforeUnload();
  if (typeof window !== "undefined") delete window.__PRACHT_BLOCK_NAVIGATION__;
  registered = null;
  state = "unblocked";
  blockedLocation = null;
  retryBlockedNavigation = null;
  bypassNextCheck = false;
  listeners.clear();
}
