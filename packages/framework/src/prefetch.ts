import { stripBase } from "./base.ts";
import { matchResolvedRoute } from "./route-matching.ts";
import { clearPrefetchCache, getCachedRouteState, trimMapToSize } from "./prefetch-cache.ts";
import { prefetchRouteState } from "./prefetch-api.ts";
import { PREFETCH_ATTRIBUTE, SPECULATE_ATTRIBUTE } from "./runtime-constants.ts";
import {
  isSpeculationSuppressed,
  normalizeSpeculation,
  supportsSpeculationRules,
} from "./runtime-speculation.ts";
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
  const renderPrefetchedAnchors = new WeakSet<HTMLAnchorElement>();
  const observedAnchors = new WeakSet<HTMLAnchorElement>();
  const matchCache = new Map<string, MatchCacheEntry>();
  const browserSupportsSpeculationRules = supportsSpeculationRules();

  /** Route path for an href, or null when it is unparseable or outside the base. */
  function getRoutePathname(url: string): string | null {
    try {
      return stripBase(new URL(url, window.location.href).pathname);
    } catch {
      return null;
    }
  }

  function getInternalHref(anchor: HTMLAnchorElement): string | null {
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return null;

    let url: URL;
    try {
      // Match native anchor resolution: relative and query-only hrefs are
      // based on the current document, including its deploy base.
      url = new URL(href, window.location.href);
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
    const match = routePathname ? (matchResolvedRoute(app, routePathname) ?? null) : null;
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
    if (entry.match.route.hydration === "islands" || entry.match.route.hydration === "none") {
      return "none";
    }
    // Routes that opted into `prerender` speculation rules are handled by the
    // browser end-to-end (full document prerender + click activation), so JS
    // prefetch would only double-fetch the route state. Anchors the rules
    // exclude are never prerendered, so they keep the JS strategy.
    if (
      browserSupportsSpeculationRules &&
      normalizeSpeculation(entry.match.route.speculation)?.mode === "prerender" &&
      !isSpeculationSuppressed(anchor)
    ) {
      return "none";
    }
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
              if (!href || getAnchorStrategy(anchor, href) !== "viewport") {
                observer?.unobserve(anchor);
                observedAnchors.delete(anchor);
                continue;
              }
              prefetchHref(href);
              observer?.unobserve(anchor);
              observedAnchors.delete(anchor);
            }
          },
          { rootMargin: "200px" },
        );

  function processAnchor(anchor: HTMLAnchorElement): void {
    const href = getInternalHref(anchor);
    if (!href) {
      if (observedAnchors.delete(anchor)) observer?.unobserve(anchor);
      return;
    }
    const strategy = getAnchorStrategy(anchor, href);
    if (strategy === "render") {
      if (observedAnchors.delete(anchor)) observer?.unobserve(anchor);
      if (!renderPrefetchedAnchors.has(anchor)) {
        renderPrefetchedAnchors.add(anchor);
        prefetchHref(href);
      }
      return;
    }
    if (strategy === "viewport" && observer) {
      if (!observedAnchors.has(anchor)) {
        observedAnchors.add(anchor);
        observer.observe(anchor);
      }
      return;
    }
    if (observedAnchors.delete(anchor)) observer?.unobserve(anchor);
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

  // Process newly-added subtrees and re-evaluate anchors when an exclusion
  // changes. Browser document rules react to the same attribute mutations.
  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.attributeName === SPECULATE_ATTRIBUTE) {
          processAnchors(record.target as Element);
        } else if (record.target instanceof HTMLAnchorElement) {
          processAnchor(record.target);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement || node instanceof DocumentFragment) {
          processAnchors(node);
        }
      }
    }
  });
  // Observe from the document root so a page-wide opt-out on `<html>` is as
  // reactive as one mounted anywhere inside `<body>`.
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [SPECULATE_ATTRIBUTE, "rel"],
    childList: true,
    subtree: true,
  });
}
