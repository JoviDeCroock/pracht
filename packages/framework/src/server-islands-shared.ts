/**
 * Shared constants for server islands. Kept in a dependency-free module
 * so the tiny swap script, the client server island component, and the server
 * renderer agree on the wire format without pulling each other in.
 */

/** Custom element the server wraps around every server island. */
export const SERVER_ISLAND_ELEMENT = "pracht-server-island";

/** Attribute carrying the server island's project-root-relative source file. */
export const SERVER_ISLAND_FILE_ATTRIBUTE = "island";

/** Attribute carrying the JSON-serialized props (omitted for empty props). */
export const SERVER_ISLAND_PROPS_ATTRIBUTE = "props";

/**
 * Present while a server island still shows its fallback and waits for the server island
 * endpoint. Removed once the request-time HTML has been swapped in.
 */
export const SERVER_ISLAND_PENDING_ATTRIBUTE = "pending";

/**
 * Set on `<html>` once the swap script has settled every pending server island on
 * the page, successfully or not. Test tooling can wait for
 * `html[data-pracht-server-islands-ready="true"]`.
 */
export const SERVER_ISLANDS_READY_MARKER = "data-pracht-server-islands-ready";

/** Base-free path of the endpoint that renders one server island per request. */
export const PRACHT_SERVER_ISLAND_ENDPOINT = "/__pracht/server-island";

/**
 * Required on every server island request. Browsers cannot attach a custom header
 * to a top-level navigation or a cross-origin request without a CORS
 * preflight the endpoint never grants, so a server island can only be fetched by
 * a same-origin script.
 */
export const SERVER_ISLAND_REQUEST_HEADER = "x-pracht-server-island";

/**
 * Set on a server island response whose HTML contains island markers. Its value is
 * the islands bootstrap URL the swap script imports to hydrate them.
 */
export const SERVER_ISLAND_ISLANDS_HEADER = "x-pracht-islands";

/** Dispatched (bubbling) on a server island element after its HTML was swapped in. */
export const SERVER_ISLAND_SWAP_EVENT = "pracht:server-island";

/**
 * Dispatched on `window` after route data was refreshed in place — by
 * `useRevalidate()`, a capability call, or a `<Form>` submission — so the
 * server islands on a full-hydration page fetch their HTML again.
 */
export const SERVER_ISLAND_REFRESH_EVENT = "pracht:server-islands-refresh";

/**
 * Development only. The dev server computes which server islands the requested
 * page's route and shell modules import, and hands that map to the runtime in
 * this request header — after removing any copy the client sent. A built app
 * never reads it: its bindings ship in the server bundle.
 */
export const DEV_SERVER_ISLAND_BINDINGS_HEADER = "x-pracht-dev-server-island-bindings";

/** Query parameters of the server island endpoint. */
export const SERVER_ISLAND_QUERY_FILE = "island";
export const SERVER_ISLAND_QUERY_PROPS = "props";
export const SERVER_ISLAND_QUERY_PATH = "path";

/**
 * Upper bound on the serialized props a server island request may carry. Props
 * travel in the query string, and the endpoint is a public GET surface.
 */
export const MAX_SERVER_ISLAND_PROPS_LENGTH = 4096;
