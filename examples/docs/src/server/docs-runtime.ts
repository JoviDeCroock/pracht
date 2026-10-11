import data from "virtual:docs-mcp-index";

import { hydrateDocsIndex, type DocsIndex } from "./docs-index.ts";

let index: DocsIndex | undefined;

/**
 * The prebuilt docs index (see vite-plugin-docs-index.ts), turned into lookups
 * on the first tool call and reused for the life of the isolate.
 */
export function docsIndex(): DocsIndex {
  return (index ??= hydrateDocsIndex(data));
}
