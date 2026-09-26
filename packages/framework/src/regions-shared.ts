/**
 * Shared constants for request-time regions. Kept in a dependency-free module
 * so the tiny swap script, the client region component, and the server
 * renderer agree on the wire format without pulling each other in.
 */

/** Custom element the server wraps around every region. */
export const REGION_ELEMENT = "pracht-region";

/** Attribute carrying the region's project-root-relative source file. */
export const REGION_FILE_ATTRIBUTE = "region";

/** Attribute carrying the JSON-serialized props (omitted for empty props). */
export const REGION_PROPS_ATTRIBUTE = "props";

/**
 * Present while a region still shows its fallback and waits for the region
 * endpoint. Removed once the request-time HTML has been swapped in.
 */
export const REGION_PENDING_ATTRIBUTE = "pending";

/**
 * Set on `<html>` once the swap script has settled every pending region on
 * the page, successfully or not. Test tooling can wait for
 * `html[data-pracht-regions-ready="true"]`.
 */
export const REGIONS_READY_MARKER = "data-pracht-regions-ready";

/** Base-free path of the endpoint that renders one region per request. */
export const PRACHT_REGION_ENDPOINT = "/__pracht/region";

/**
 * Required on every region request. Browsers cannot attach a custom header
 * to a top-level navigation or a cross-origin request without a CORS
 * preflight the endpoint never grants, so a region can only be fetched by
 * a same-origin script.
 */
export const REGION_REQUEST_HEADER = "x-pracht-region";

/**
 * Set on a region response whose HTML contains island markers. Its value is
 * the islands bootstrap URL the swap script imports to hydrate them.
 */
export const REGION_ISLANDS_HEADER = "x-pracht-islands";

/** Dispatched (bubbling) on a region element after its HTML was swapped in. */
export const REGION_SWAP_EVENT = "pracht:region";

/** Query parameters of the region endpoint. */
export const REGION_QUERY_FILE = "region";
export const REGION_QUERY_PROPS = "props";
export const REGION_QUERY_PATH = "path";

/**
 * Upper bound on the serialized props a region request may carry. Props
 * travel in the query string, and the endpoint is a public GET surface.
 */
export const MAX_REGION_PROPS_LENGTH = 4096;
