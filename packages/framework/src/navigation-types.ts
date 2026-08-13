/** @internal Wide route target used by framework implementations before public type narrowing. */
export interface UntypedRouteTarget {
  route: string;
  params?: Record<string, unknown>;
  search?: unknown;
  hash?: string;
}

export interface NavigateOptions {
  replace?: boolean;
  /**
   * Keep the current scroll position after the navigation commits instead of
   * scrolling to the top (or to the target `#hash` element).
   */
  preserveScroll?: boolean;
  /**
   * Wrap this navigation's DOM commit in `document.startViewTransition()`
   * when the browser supports it. Overrides the app-level
   * `viewTransitions` default for this navigation.
   */
  viewTransition?: boolean;
}

export type PrefetchStrategy = "none" | "hover" | "viewport" | "intent";

/**
 * Per-link prefetch strategy accepted by `<Link prefetch>`. Extends the
 * route-level strategies with `"render"`, which prefetches as soon as the
 * link is rendered.
 */
export type LinkPrefetchStrategy = PrefetchStrategy | "render";

/**
 * Browser-native speculation rules. Emitted as `<script type="speculationrules">`
 * in the SSR/SSG HTML. Complements the JS-based `prefetch` strategies — those
 * fetch route-state JSON for SPA navigation; this opts the browser into HTML
 * prefetch or full prerender so a click can swap to an already-rendered document.
 *
 * - `prefetch`: browser fetches the page HTML on intent (default eagerness
 *   `moderate` — ~hover/touchstart). Useful for full-page navigations and
 *   middle-click / new-tab opens.
 * - `prerender`: browser fully renders the page (running its JS) in the
 *   background; click navigates instantly. The SPA click handler skips
 *   prerender-marked routes so the browser can activate the prerendered
 *   document instead of intercepting the click. Default eagerness
 *   `conservative` (touchstart / mousedown).
 */
export type SpeculationMode = "prefetch" | "prerender";

export type SpeculationEagerness = "immediate" | "eager" | "moderate" | "conservative";

export interface SpeculationConfig {
  mode: SpeculationMode;
  eagerness?: SpeculationEagerness;
}

export type SpeculationOption = SpeculationMode | SpeculationConfig;
