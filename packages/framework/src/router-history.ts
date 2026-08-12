import {
  decodeFragmentId,
  findFragmentTarget,
  focusFragmentTarget,
  scrollToFragmentTarget,
} from "./fragment-navigation.ts";
import { dispatchHashChange } from "./router-browser.ts";
import {
  createScrollPositionStore,
  generateScrollKey,
  getSessionScrollStorage,
  readScrollKeyFromHistoryState,
  withScrollKeyInHistoryState,
} from "./scroll-restoration.ts";

export interface RouterHistoryCommitOptions {
  replace?: boolean;
}

export interface RouterScrollOptions {
  preserveScroll?: boolean;
  traversal?: boolean;
}

export interface RouterHistoryController {
  commitFragmentNavigation(url: URL, preserveScroll: boolean): void;
  commitRouteNavigation(browserUrl: string, options?: RouterHistoryCommitOptions): void;
  installPopstateHandler(navigate: (url: string) => void): void;
  restoreInitialScroll(): void;
  restoreOrResetScroll(options: RouterScrollOptions | undefined, browserUrl: string): void;
}

/**
 * Own the browser history entry and scroll-position lifecycle for one client
 * router. Keeping these values together prevents click, navigation, and
 * popstate flows from updating only part of the shared history state.
 */
export function createRouterHistoryController(): RouterHistoryController {
  const scrollStore = createScrollPositionStore(getSessionScrollStorage());
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  let currentScrollKey = readScrollKeyFromHistoryState(history.state) ?? "";
  const hadExistingScrollKey = currentScrollKey !== "";
  if (!hadExistingScrollKey) {
    currentScrollKey = generateScrollKey();
    try {
      history.replaceState(
        withScrollKeyInHistoryState(history.state, currentScrollKey),
        "",
        window.location.href,
      );
    } catch {
      // Some embedders restrict history mutation. Restoration then degrades to
      // scroll-to-top, matching navigation without persisted history state.
    }
  }

  let currentDocumentPath = window.location.pathname + window.location.search;

  function saveScrollPosition(): void {
    scrollStore.set(currentScrollKey, { x: window.scrollX, y: window.scrollY });
  }

  window.addEventListener("pagehide", saveScrollPosition);

  function restoreOrResetScroll(
    options: RouterScrollOptions | undefined,
    browserUrl: string,
  ): void {
    if (options?.preserveScroll) return;

    if (options?.traversal) {
      const saved = scrollStore.get(currentScrollKey);
      if (saved) {
        window.scrollTo(saved.x, saved.y);
        return;
      }
    }

    const hashIndex = browserUrl.indexOf("#");
    if (hashIndex !== -1) {
      const hashTarget = findFragmentTarget(document, browserUrl.slice(hashIndex));
      if (hashTarget) {
        scrollToFragmentTarget(hashTarget);
        return;
      }
    }

    window.scrollTo(0, 0);
  }

  function scrollToFragment(hash: string): void {
    const target = findFragmentTarget(document, hash);
    if (target) {
      scrollToFragmentTarget(target);
      return;
    }

    const id = decodeFragmentId(hash);
    if (id === "" || id.toLowerCase() === "top") {
      window.scrollTo(0, 0);
    }
  }

  function commitFragmentNavigation(url: URL, preserveScroll: boolean): void {
    const previousUrl = window.location.href;

    if (url.href !== previousUrl) {
      saveScrollPosition();
      const nextScrollKey = generateScrollKey();
      try {
        history.pushState(
          withScrollKeyInHistoryState(null, nextScrollKey),
          "",
          url.pathname + url.search + url.hash,
        );
        currentScrollKey = nextScrollKey;
      } catch {
        // The fragment can still be reached when history mutation is blocked.
      }
    }
    currentDocumentPath = url.pathname + url.search;

    if (!preserveScroll) {
      scrollToFragment(url.hash);
    }

    const nextUrl = window.location.href;
    if (nextUrl !== previousUrl) {
      dispatchHashChange(previousUrl, nextUrl);
    }
  }

  function commitRouteNavigation(browserUrl: string, options?: RouterHistoryCommitOptions): void {
    saveScrollPosition();
    if (options?.replace) {
      history.replaceState(
        withScrollKeyInHistoryState(history.state, currentScrollKey),
        "",
        browserUrl,
      );
    } else {
      const nextScrollKey = generateScrollKey();
      history.pushState(withScrollKeyInHistoryState(null, nextScrollKey), "", browserUrl);
      currentScrollKey = nextScrollKey;
    }

    const hashIndex = browserUrl.indexOf("#");
    currentDocumentPath = hashIndex === -1 ? browserUrl : browserUrl.slice(0, hashIndex);
  }

  function installPopstateHandler(navigate: (url: string) => void): void {
    window.addEventListener("popstate", () => {
      // The visible scroll still belongs to the entry being left. Save it
      // before adopting the key from the destination history entry.
      saveScrollPosition();

      let nextScrollKey = readScrollKeyFromHistoryState(history.state);
      const nextDocumentPath = window.location.pathname + window.location.search;

      // A missing key on the same document identifies a fragment entry made
      // outside the router. A missing key on another document must still be
      // treated as route traversal, even if app code wiped history.state.
      const isFragmentNavigation = !nextScrollKey && nextDocumentPath === currentDocumentPath;

      if (!nextScrollKey) {
        nextScrollKey = generateScrollKey();
        try {
          history.replaceState(
            withScrollKeyInHistoryState(history.state, nextScrollKey),
            "",
            window.location.href,
          );
        } catch {
          // Restoration degrades to scroll-to-top when state cannot be stamped.
        }
      }
      currentScrollKey = nextScrollKey;

      if (isFragmentNavigation) {
        const fragmentTarget = findFragmentTarget(document, window.location.hash);
        if (fragmentTarget) focusFragmentTarget(fragmentTarget);
        return;
      }

      currentDocumentPath = nextDocumentPath;
      navigate(window.location.pathname + window.location.search + window.location.hash);
    });
  }

  function restoreInitialScroll(): void {
    if (!hadExistingScrollKey) return;
    const savedPosition = scrollStore.get(currentScrollKey);
    if (savedPosition) {
      window.scrollTo(savedPosition.x, savedPosition.y);
    }
  }

  return {
    commitFragmentNavigation,
    commitRouteNavigation,
    installPopstateHandler,
    restoreInitialScroll,
    restoreOrResetScroll,
  };
}
