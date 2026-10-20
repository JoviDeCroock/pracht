// The contract the factory returns, re-exported so a value of it can be named
// from this package alone.
export type { PrachtAdapter } from "@pracht/core/adapter";

export {
  createStaticServerEntryModule,
  staticAdapter,
  type StaticAdapterOptions,
} from "./static-entry.ts";
export { createStaticPreviewHandler, type StaticPreviewHandlerOptions } from "./static-preview.ts";
