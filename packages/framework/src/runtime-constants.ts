import type { RouteParams, RouteSearchRecord } from "./types.ts";

export const SAFE_METHODS = new Set(["GET", "HEAD"]);
export const HYDRATION_STATE_ELEMENT_ID = "pracht-state";
export const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
export const ROUTE_STATE_CACHE_CONTROL = "no-store";
export const EMPTY_ROUTE_PARAMS = {} as RouteParams;
export const EMPTY_ROUTE_SEARCH = {} as RouteSearchRecord;

// Identity of the app-level not-found page. It is route-shaped so the render
// pipeline can treat it like any other route, but it lives outside the route
// table: the id is reserved (typed routes can never produce it) and the path
// is a label rather than a pattern, because nothing ever matches against it.
export const NOT_FOUND_ROUTE_ID = "__pracht_not_found__";
export const NOT_FOUND_ROUTE_PATH = "(not found)";

// Data attributes rendered by <Link> and read by the client router's
// document-level click handler / the lazy prefetch listeners.
export const PREFETCH_ATTRIBUTE = "data-pracht-prefetch";
export const PRESERVE_SCROLL_ATTRIBUTE = "data-pracht-preserve-scroll";
export const VIEW_TRANSITION_ATTRIBUTE = "data-pracht-view-transition";
