import { matchAppRoute } from "./app.ts";
import { clearPrefetchCache, getCachedRouteState, trimMapToSize } from "./prefetch-cache.ts";
import { prefetchRouteState } from "./prefetch-api.ts";
import { PREFETCH_ATTRIBUTE } from "./runtime-constants.ts";
import type { ModuleWarmFn } from "./prefetch-api.ts";
import type {
  LinkPrefetchStrategy,
  ResolvedPrachtApp,
  PrefetchStrategy,
  RouteMatch,
} from "./types.ts";

export type { ModuleWarmFn };

const MAX_MATCH_CACHE_ENTRIES = 250;

const LINK_PREFETCH_STRATEGIES: ReadonlySet<string> = new Set([
  "none",
  "hover",
  "intent",
  "viewport",
  "render",
]);

interface MatchCacheEntry {
  match: RouteMatch | null;
  strategy: PrefetchStrategy;
}

export { clearPrefetchCache, getCachedRouteState, prefetchRouteState };

export function setupPrefetching(app: ResolvedPrachtApp, warmModules?: ModuleWarmFn): void {
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const processedAnchors = new WeakSet<HTMLAnchorElement>();
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
    // Islands / no-hydration routes use full document navigation, so
    // prefetching route-state JSON or client modules for them is wasted work.
    const isFullDocumentRoute =
      match?.route.hydration === "islands" || match?.route.hydration === "none";
    const strategy: PrefetchStrategy =
      match && !isFullDocumentRoute ? (match.route.prefetch ?? "intent") : "none";
    const entry = { match, strategy };
    matchCache.set(href, entry);
    trimMapToSize(matchCache, MAX_MATCH_CACHE_ENTRIES);
    return entry;
  }

  /**
   * Per-anchor `data-pracht-prefetch` (rendered by `<Link prefetch>`) wins
   * over the route-level strategy; unmatched hrefs are never prefetched.
   */
  function getAnchorStrategy(anchor: HTMLAnchorElement, href: string): LinkPrefetchStrategy {
    const entry = getMatchEntry(href);
    if (!entry.match) return "none";
    const override = anchor.getAttribute(PREFETCH_ATTRIBUTE);
    if (override && LINK_PREFETCH_STRATEGIES.has(override)) {
      return override as LinkPrefetchStrategy;
    }
    return entry.strategy;
  }

  function prefetchHref(href: string): void {
    const match = getMatchEntry(href).match;
    if (!match) return;
    prefetchRouteState(href, match.route);
    if (warmModules) warmModules(match);
  }

  // Hover / focus prefetching (intent-based)
  document.addEventListener(
    "mouseenter",
    (e: MouseEvent) => {
      const anchor = (e.target as Element).closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = getInternalHref(anchor);
      if (!href) return;

      const strategy = getAnchorStrategy(anchor, href);
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

      const strategy = getAnchorStrategy(anchor, href);
      if (strategy !== "hover" && strategy !== "intent") return;

      prefetchHref(href);
    },
    true,
  );

  // Viewport-based prefetching via IntersectionObserver
  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const anchor = entry.target as HTMLAnchorElement;
              const href = getInternalHref(anchor);
              if (!href) continue;
              prefetchHref(href);
              observer?.unobserve(anchor);
            }
          },
          { rootMargin: "200px" },
        );

  function processAnchor(anchor: HTMLAnchorElement): void {
    if (processedAnchors.has(anchor)) return;
    const href = getInternalHref(anchor);
    if (!href) return;
    const strategy = getAnchorStrategy(anchor, href);
    if (strategy === "render") {
      processedAnchors.add(anchor);
      prefetchHref(href);
      return;
    }
    if (strategy !== "viewport" || !observer) return;
    processedAnchors.add(anchor);
    observer.observe(anchor);
  }

  function processAnchors(root: ParentNode): void {
    if (root instanceof HTMLAnchorElement) {
      processAnchor(root);
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      processAnchor(anchor);
    }
  }

  processAnchors(document.body);

  // Observe only newly-added DOM subtrees instead of re-scanning the whole document.
  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement || node instanceof DocumentFragment) {
          processAnchors(node);
        }
      }
    }
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
}
