import { matchAppRoute } from "./app.ts";
import {
  cacheRouteState,
  clearPrefetchCache,
  EMPTY_ROUTE_STATE_PROMISE,
  getCachedRouteState,
  trimMapToSize,
} from "./prefetch-cache.ts";
import { fetchPrachtRouteState, routeNeedsServerFetch } from "./runtime-client-fetch.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";
import type { ResolvedPrachtApp, ResolvedRoute, PrefetchStrategy, RouteMatch } from "./types.ts";

export type ModuleWarmFn = (match: RouteMatch) => void;

const MAX_MATCH_CACHE_ENTRIES = 250;

interface MatchCacheEntry {
  match: RouteMatch | null;
  strategy: PrefetchStrategy;
}

export { clearPrefetchCache, getCachedRouteState };

export function prefetchRouteState(url: string, route?: ResolvedRoute): Promise<RouteStateResult> {
  if (route && !routeNeedsServerFetch(route)) return EMPTY_ROUTE_STATE_PROMISE;

  const cached = getCachedRouteState(url);
  if (cached) return cached;

  const promise = fetchPrachtRouteState(url);
  cacheRouteState(url, promise);
  return promise;
}

export function setupPrefetching(app: ResolvedPrachtApp, warmModules?: ModuleWarmFn): void {
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const observedViewportAnchors = new WeakSet<HTMLAnchorElement>();
  const matchCache = new Map<string, MatchCacheEntry>();

  function getRoutePathname(url: string): string | null {
    try {
      return new URL(url, window.location.origin).pathname;
    } catch {
      return null;
    }
  }

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

  function getMatchEntry(href: string): MatchCacheEntry {
    const cached = matchCache.get(href);
    if (cached) {
      matchCache.delete(href);
      matchCache.set(href, cached);
      return cached;
    }

    const routePathname = getRoutePathname(href);
    const match = routePathname ? (matchAppRoute(app, routePathname) ?? null) : null;
    const strategy = match ? (match.route.prefetch ?? "intent") : "none";
    const entry = { match, strategy };
    matchCache.set(href, entry);
    trimMapToSize(matchCache, MAX_MATCH_CACHE_ENTRIES);
    return entry;
  }

  function prefetchHref(href: string): void {
    const match = getMatchEntry(href).match;
    prefetchRouteState(href, match?.route);
    if (warmModules && match) warmModules(match);
  }

  // Hover / focus prefetching (intent-based)
  document.addEventListener(
    "mouseenter",
    (e: MouseEvent) => {
      const anchor = (e.target as Element).closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = getInternalHref(anchor);
      if (!href) return;

      const strategy = getMatchEntry(href).strategy;
      if (strategy !== "hover" && strategy !== "intent") return;

      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        prefetchHref(href);
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

      const strategy = getMatchEntry(href).strategy;
      if (strategy !== "hover" && strategy !== "intent") return;

      prefetchHref(href);
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
        prefetchHref(href);
        observer.unobserve(anchor);
      }
    },
    { rootMargin: "200px" },
  );

  function observeAnchor(anchor: HTMLAnchorElement): void {
    if (observedViewportAnchors.has(anchor)) return;
    const href = getInternalHref(anchor);
    if (!href) return;
    const strategy = getMatchEntry(href).strategy;
    if (strategy !== "viewport") return;
    observedViewportAnchors.add(anchor);
    observer.observe(anchor);
  }

  function observeViewportLinks(root: ParentNode): void {
    if (root instanceof HTMLAnchorElement) {
      observeAnchor(root);
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      observeAnchor(anchor);
    }
  }

  observeViewportLinks(document.body);

  // Observe only newly-added DOM subtrees instead of re-scanning the whole document.
  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement || node instanceof DocumentFragment) {
          observeViewportLinks(node);
        }
      }
    }
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
}
