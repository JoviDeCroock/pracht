import { matchResolvedRoute } from "./route-pattern.ts";
import type { RouterHistoryController } from "./router-history.ts";
import { PRESERVE_SCROLL_ATTRIBUTE, VIEW_TRANSITION_ATTRIBUTE } from "./runtime-constants.ts";
import { normalizeSpeculation, supportsSpeculationRules } from "./runtime-speculation.ts";
import type { NavigateOptions, ResolvedPrachtApp } from "./types.ts";

export interface RouterLinkInterceptorOptions {
  app: ResolvedPrachtApp;
  history: RouterHistoryController;
  navigate: (url: string, options?: NavigateOptions) => void;
}

/** Install the router's declarative same-origin anchor interception policy. */
export function installRouterLinkInterceptor(options: RouterLinkInterceptorOptions): void {
  const { app, history, navigate } = options;

  document.addEventListener("click", (event: MouseEvent) => {
    const anchor = (event.target as Element).closest?.("a");
    if (!anchor) return;

    // Preserve native behavior for modified clicks, downloads, and other
    // browsing contexts.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.defaultPrevented || event.button !== 0) return;
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return;
    if (anchor.hasAttribute("download")) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    // A bare fragment resolves against the current document. Other relative
    // links retain the framework's origin-root resolution semantics.
    const isFragmentHref = href.startsWith("#");
    let url: URL;
    try {
      url = new URL(href, isFragmentHref ? window.location.href : window.location.origin);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;

    const isSameDocument =
      url.pathname + url.search === window.location.pathname + window.location.search;
    if (isSameDocument && (url.hash !== "" || isFragmentHref)) {
      event.preventDefault();
      history.commitFragmentNavigation(url, anchor.hasAttribute(PRESERVE_SCROLL_ATTRIBUTE));
      return;
    }

    // A prerendered document must reach the browser's native navigation path
    // so it can activate instead of being redundantly fetched as route state.
    const targetMatch = matchResolvedRoute(app, url.pathname);
    if (targetMatch && supportsSpeculationRules()) {
      const speculation = normalizeSpeculation(targetMatch.route.speculation);
      if (speculation?.mode === "prerender") return;
    }

    event.preventDefault();
    const navigationOptions: NavigateOptions = {};
    if (anchor.hasAttribute(PRESERVE_SCROLL_ATTRIBUTE)) {
      navigationOptions.preserveScroll = true;
    }
    if (anchor.hasAttribute(VIEW_TRANSITION_ATTRIBUTE)) {
      navigationOptions.viewTransition = true;
    }
    navigate(url.pathname + url.search + url.hash, navigationOptions);
  });
}
