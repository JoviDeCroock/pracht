import { matchAppRoute } from "./app.ts";
import { fetchPreviteRouteState } from "./runtime.ts";
import type { RouteStateResult } from "./runtime.ts";
import type { ResolvedPreviteApp, PrefetchStrategy } from "./types.ts";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  promise: Promise<RouteStateResult>;
  timestamp: number;
}

const prefetchCache = new Map<string, CacheEntry>();

export function getCachedRouteState(url: string): Promise<RouteStateResult> | null {
  const entry = prefetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    prefetchCache.delete(url);
    return null;
  }
  return entry.promise;
}

export function prefetchRouteState(url: string): Promise<RouteStateResult> {
  const cached = getCachedRouteState(url);
  if (cached) return cached;

  const promise = fetchPreviteRouteState(url);
  prefetchCache.set(url, { promise, timestamp: Date.now() });
  return promise;
}

export function setupPrefetching(app: ResolvedPreviteApp): void {
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  function getInternalHref(anchor: HTMLAnchorElement): string | null {
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return null;

    let url: URL;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return null;
    }

    if (url.origin !== window.location.origin) return null;
    return url.pathname + url.search;
  }

  function getPrefetchStrategy(pathname: string): PrefetchStrategy {
    const match = matchAppRoute(app, pathname);
    if (!match) return "none";
    // Use route-level config, or default based on render mode
    if (match.route.prefetch) return match.route.prefetch;
    // SPA routes fetch on load anyway — no benefit from prefetch
    if (match.route.render === "spa") return "none";
    return "intent";
  }

  // Hover / focus prefetching (intent-based)
  document.addEventListener(
    "mouseenter",
    (e: MouseEvent) => {
      const anchor = (e.target as Element).closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = getInternalHref(anchor);
      if (!href) return;

      const strategy = getPrefetchStrategy(href);
      if (strategy !== "hover" && strategy !== "intent") return;

      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        prefetchRouteState(href);
      }, 50);
    },
    true,
  );

  document.addEventListener(
    "mouseleave",
    (e: MouseEvent) => {
      const anchor = (e.target as Element).closest?.("a");
      if (!anchor) return;
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    },
    true,
  );

  document.addEventListener(
    "focusin",
    (e: FocusEvent) => {
      const anchor = (e.target as Element).closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = getInternalHref(anchor);
      if (!href) return;

      const strategy = getPrefetchStrategy(href);
      if (strategy !== "hover" && strategy !== "intent") return;

      prefetchRouteState(href);
    },
    true,
  );

  // Viewport-based prefetching via IntersectionObserver
  if (typeof IntersectionObserver === "undefined") return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const anchor = entry.target as HTMLAnchorElement;
        const href = getInternalHref(anchor);
        if (!href) continue;
        prefetchRouteState(href);
        observer.unobserve(anchor);
      }
    },
    { rootMargin: "200px" },
  );

  // Observe existing viewport-prefetch links and re-observe on DOM changes
  function observeViewportLinks(): void {
    const anchors = document.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const anchor of anchors) {
      const href = getInternalHref(anchor);
      if (!href) continue;
      const strategy = getPrefetchStrategy(href);
      if (strategy !== "viewport") continue;
      observer.observe(anchor);
    }
  }

  observeViewportLinks();

  // Re-observe after client-side navigation updates the DOM
  const mutationObserver = new MutationObserver(() => {
    observeViewportLinks();
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
}
