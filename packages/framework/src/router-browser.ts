export interface BrowserRouteTarget {
  browserUrl: string;
  pathname: string;
  requestUrl: string;
  search: string;
}

/**
 * Fire the `hashchange` the platform would have fired for a fragment
 * navigation the router intercepted. Both URLs are absolute, as the event's
 * `oldURL`/`newURL` are specified to be.
 */
export function dispatchHashChange(oldURL: string, newURL: string): void {
  let event: Event;
  try {
    event = new HashChangeEvent("hashchange", { oldURL, newURL });
  } catch {
    // Environments without the HashChangeEvent constructor still get the
    // notification, just without the URL details.
    event = new Event("hashchange");
  }
  window.dispatchEvent(event);
}

interface ViewTransitionLike {
  updateCallbackDone?: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike;
};

/**
 * Commit a navigation's DOM update, optionally wrapped in
 * `document.startViewTransition()`. Falls back to a plain commit when view
 * transitions are disabled or unsupported. Resolves once the DOM update has
 * been applied (not when the transition animation finishes).
 */
export async function commitWithOptionalViewTransition(
  commit: () => void,
  useViewTransition: boolean,
): Promise<void> {
  const doc = document as ViewTransitionDocument;
  if (!useViewTransition || typeof doc.startViewTransition !== "function") {
    commit();
    return;
  }

  let committed = false;
  let transition: ViewTransitionLike | undefined;
  try {
    transition = doc.startViewTransition(async () => {
      committed = true;
      commit();
      // Preact flushes state updates asynchronously — wait a macrotask so the
      // new route's DOM is in place before the transition captures snapshots.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  } catch {
    // Defensive: a broken partial implementation must not break navigation.
  }

  try {
    await transition?.updateCallbackDone;
  } catch {
    // The transition was skipped — the DOM update itself still applied.
  }

  if (!committed) {
    commit();
  }
}

/** Resolve a same-origin navigation target into its browser and request URLs. */
export function resolveBrowserRouteTarget(to: string): BrowserRouteTarget | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin) {
      return null;
    }

    return {
      browserUrl: url.pathname + url.search + url.hash,
      pathname: url.pathname,
      requestUrl: url.pathname + url.search,
      search: url.search,
    };
  } catch {
    return null;
  }
}
