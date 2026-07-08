/**
 * Shared constants for the islands (partial hydration) runtime. Kept in a
 * dependency-free module so the tiny client bootstrap and the server renderer
 * agree on the wire format without pulling each other in.
 */

/** Custom element the server wraps around every island's SSR output. */
export const ISLAND_ELEMENT = "pracht-island";

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
