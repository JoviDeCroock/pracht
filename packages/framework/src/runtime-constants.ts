import type { RouteParams } from "./types.ts";

/**
 * Set to `"1"` by the pracht CLI around the short-lived Vite server it boots
 * for graph-reading commands (`inspect`, `verify`, `doctor`, `plan`, `report`,
 * `typegen`). Those commands evaluate only the adapter-neutral
 * `virtual:pracht/dev-metadata` module, so the vite plugin omits
 * adapter-contributed Vite plugins — some of which own resources that
 * `server.close()` does not reclaim (`@cloudflare/vite-plugin` starts workerd
 * plus a debugger socket, which kept those commands alive indefinitely).
 *
 * Declared here so the CLI and the vite plugin cannot drift on the name.
 */
export const PRACHT_GRAPH_ONLY_ENV = "PRACHT_GRAPH_ONLY";

export const SAFE_METHODS = new Set(["GET", "HEAD"]);
export const HYDRATION_STATE_ELEMENT_ID = "pracht-state";
export const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
export const ROUTE_STATE_CACHE_CONTROL = "no-store";
export const EMPTY_ROUTE_PARAMS = {} as RouteParams;

/**
 * Directory holding the build-time route-state snapshots a static deployment
 * serves in place of the route-state endpoint. `/blog/hello` is answered from
 * `/_pracht/state/blog/hello/index.json`, and `/` from
 * `/_pracht/state/index.json`.
 *
 * Shared by the CLI (which writes the files) and the client router (which
 * fetches them) so the two cannot drift.
 */
export const STATIC_ROUTE_STATE_DIR = "/_pracht/state";

// Identity of the app-level not-found page. It is route-shaped so the render
// pipeline can treat it like any other route, but it lives outside the route
// table: the id is reserved (typed routes can never produce it) and the path
// is a label rather than a pattern, because nothing ever matches against it.
export const NOT_FOUND_ROUTE_ID = "__pracht_not_found__";
export const NOT_FOUND_ROUTE_PATH = "(not found)";

/**
 * Probe path the static build renders the not-found page at. It has to match
 * no route for the runtime to reach the not-found branch at all, and it is
 * never a real URL: the rendered document is written to `404.html`.
 */
export const NOT_FOUND_PRERENDER_PATH = "/__pracht_not_found__";

// Data attributes rendered by <Link> and read by the client router's
// document-level click handler / the lazy prefetch listeners.
export const PREFETCH_ATTRIBUTE = "data-pracht-prefetch";
export const PRESERVE_SCROLL_ATTRIBUTE = "data-pracht-preserve-scroll";
export const VIEW_TRANSITION_ATTRIBUTE = "data-pracht-view-transition";
