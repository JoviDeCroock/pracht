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

/**
 * RFC 9728 well-known prefix for OAuth 2.0 protected-resource metadata.
 *
 * Lives here, not in the MCP modules, because `handlePrachtRequest()` needs to
 * recognise the path *before* it loads anything MCP-related — and before base
 * stripping, since RFC 9728 §3.1 inserts this segment between the host and the
 * resource's path, putting the document at the origin root by construction.
 */
export const OAUTH_PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";
export const HYDRATION_STATE_ELEMENT_ID = "pracht-state";
export const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
export const ROUTE_STATE_CACHE_CONTROL = "no-store";
export const EMPTY_ROUTE_PARAMS = {} as RouteParams;

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

// Cascading opt-out for browser speculation rules. Set to "off" on any
// element to exclude the anchors inside it; an anchor can set "on" to
// explicitly re-enable itself. Read by the emitted rules (as a
// `selector_matches` exclusion) and by the client router / prefetch listeners.
export const SPECULATE_ATTRIBUTE = "data-pracht-speculate";
