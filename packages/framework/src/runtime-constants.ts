import type { RouteParams } from "./types.ts";

export const SAFE_METHODS = new Set(["GET", "HEAD"]);
export const HYDRATION_STATE_ELEMENT_ID = "pracht-state";
export const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
export const ROUTE_STATE_CACHE_CONTROL = "no-store";
export const EMPTY_ROUTE_PARAMS = {} as RouteParams;

// Data attributes rendered by <Link> and read by the client router's
// document-level click handler / the lazy prefetch listeners.
export const PREFETCH_ATTRIBUTE = "data-pracht-prefetch";
export const PRESERVE_SCROLL_ATTRIBUTE = "data-pracht-preserve-scroll";
export const VIEW_TRANSITION_ATTRIBUTE = "data-pracht-view-transition";
