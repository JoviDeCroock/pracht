/**
 * Shared constants for the islands (partial hydration) runtime. Kept in a
 * dependency-free module so the tiny client bootstrap and the server renderer
 * agree on the wire format without pulling each other in.
 */

/** Custom element the server wraps around every island's SSR output. */
export const ISLAND_ELEMENT = "pracht-island";

/**
 * Element the server wraps around children passed into an island. The client
 * keeps the server-rendered nodes inside it instead of re-rendering them.
 */
export const ISLAND_SLOT_ELEMENT = "pracht-slot";

/**
 * Text of the comment that closes every slot. If the HTML parser moved
 * nodes out of a slot (invalid nesting, unbalanced raw HTML), the comment is
 * no longer its last child, and the client leaves that island unhydrated.
 */
export const ISLAND_SLOT_END = "/pracht-slot";

/** Attribute carrying the island's project-root-relative source file. */
export const ISLAND_FILE_ATTRIBUTE = "island";

/** Attribute carrying the export name of the island component. */
export const ISLAND_EXPORT_ATTRIBUTE = "export";

/** Attribute carrying the hydration strategy (omitted for the default "load"). */
export const ISLAND_STRATEGY_ATTRIBUTE = "client";

/** Attribute carrying the JSON-serialized props (omitted for empty props). */
export const ISLAND_PROPS_ATTRIBUTE = "props";

/** Set on an island element once it has hydrated. */
export const ISLAND_HYDRATED_ATTRIBUTE = "data-hydrated";

/**
 * Set on `<html>` once the islands bootstrap has hydrated every `load`
 * island on the page. Test tooling can wait for
 * `html[data-pracht-islands-hydrated="true"]` before interacting.
 */
export const ISLANDS_HYDRATED_MARKER = "data-pracht-islands-hydrated";

export const ISLAND_STRATEGIES = ["load", "idle", "visible"] as const;

// --- `client.islandsNavigation` wire format ---------------------------------

/**
 * Id of the `<script type="application/json">` an islands or `none` document
 * carries with islands navigation on: `{ "p": policy, "r": routes }`.
 *
 * - `p` is {@link policyFingerprint} of the security headers the server set on
 *   this response. Static output has none: the browser fingerprints the
 *   headers its host actually sends.
 * - `r` (islands pages only) is the route table in the server's match order:
 *   a route path prefixed `+` when a page there can be swapped in
 *   (`islands`/`none`), `-` for an API or full-hydration route that could
 *   shadow one. See `islandsNavigationRoutes()`.
 *
 * A page whose CSP carries a nonce has no data at all and never takes part.
 */
export const ISLANDS_NAVIGATION_DATA_ID = "pracht-nav";

/**
 * Marks the head nodes the server rendered, the only ones a page swap may
 * remove: nodes a script added (a theme style, a tag manager's) are not the
 * swap's.
 */
export const ISLANDS_NAVIGATION_OWNED_ATTRIBUTE = "data-pracht-owned";

/**
 * Response headers that set document-level policy. A swapped-in page keeps the
 * policy the document was loaded with, so it is only swapped when these match.
 */
const POLICY_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "permissions-policy",
  "referrer-policy",
  "document-policy",
  "document-isolation-policy",
  "integrity-policy",
  "origin-agent-cluster",
];

/** FNV-1a over the policy headers, so the document carries 6–7 characters. */
export function policyFingerprint(headers: Pick<Headers, "get">): string {
  let hash = 0x811c9dc5;
  for (const name of POLICY_HEADERS) {
    const text = `${name}:${headers.get(name) ?? ""}\n`;
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    }
  }
  return (hash >>> 0).toString(36);
}
