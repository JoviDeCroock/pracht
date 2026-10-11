import docs from "virtual:pracht/content/docs";

import { buildDocsIndex, type DocsIndex } from "./docs-index.ts";

let pending: Promise<DocsIndex> | undefined;

/**
 * The index over the deployed `docs` collection snapshot, built on the first
 * tool call and reused for the life of the isolate. A failed build is not
 * cached, so the next call retries.
 */
export function docsIndex(): Promise<DocsIndex> {
  pending ??= buildDocsIndex(docs).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
