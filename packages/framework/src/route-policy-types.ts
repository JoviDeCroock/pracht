import type { PrefetchStrategy, SpeculationOption } from "./navigation-types.ts";

export type RenderMode = "spa" | "ssr" | "ssg" | "isg";

/**
 * Per-route hydration mode.
 *
 * - `"full"` (default) — the whole page tree hydrates and the client router
 *   takes over navigation. Existing behavior, zero change.
 * - `"islands"` — only components from the islands directory (`src/islands/`)
 *   hydrate; the rest of the page ships no JavaScript. Navigation to and from
 *   these routes is regular full-document (MPA-style) navigation.
 * - `"none"` — fully static output; no JavaScript is injected at all.
 */
export type HydrationMode = "full" | "islands" | "none";

/**
 * Hydration strategy for one island usage, passed via the `client` prop:
 *
 * - `"load"` (default) — hydrate as soon as the islands bootstrap runs.
 * - `"idle"` — hydrate in a `requestIdleCallback`.
 * - `"visible"` — hydrate when the island scrolls into view
 *   (`IntersectionObserver`).
 */
export type IslandStrategy = "load" | "idle" | "visible";

/**
 * Props accepted by every island component usage on the server. Intersect
 * with your own props type: `function Counter(props: CounterProps & IslandProps)`.
 * `client` is consumed by the framework and never reaches the component.
 */
export interface IslandProps {
  client?: IslandStrategy;
}

export interface TimeRevalidatePolicy {
  kind: "time";
  seconds: number;
}

export interface WebhookRevalidatePolicy {
  kind: "webhook";
}

export type RouteRevalidatePolicy = TimeRevalidatePolicy | WebhookRevalidatePolicy;

export type RouteRevalidate = RouteRevalidatePolicy | readonly RouteRevalidatePolicy[];

/**
 * Browser cache duration for route-state loader responses, in seconds.
 * `false` and `0` disable storage with `Cache-Control: no-store`.
 */
export type LoaderCache = number | false;

export interface RouteMeta {
  id?: string;
  shell?: string;
  render?: RenderMode;
  hydration?: HydrationMode;
  /** Declare that middleware negotiates a Markdown representation for this route. */
  markdown?: boolean;
  middleware?: string[];
  revalidate?: RouteRevalidate;
  loaderCache?: LoaderCache;
  prefetch?: PrefetchStrategy;
  speculation?: SpeculationOption;
  hasLoader?: boolean;
}

export interface GroupMeta {
  shell?: string;
  render?: RenderMode;
  hydration?: HydrationMode;
  middleware?: string[];
  loaderCache?: LoaderCache;
  pathPrefix?: string;
  speculation?: SpeculationOption;
}
