/**
 * Stable middleware facade. Redirect safety, chain execution, and document
 * metadata aggregation live in focused sibling modules.
 */

export { mergeDocumentHeaders, mergeHeadMetadata } from "./runtime-document-metadata.ts";
export { runMiddlewareChain, type RunMiddlewareChainOptions } from "./runtime-middleware-chain.ts";
export { buildRedirectResponse, redirect, type RedirectOptions } from "./runtime-redirect.ts";
