// The contract the factory returns, carried in this package's own declarations
// so a value of it can be named without importing `@pracht/vite-plugin`.
export type { PrachtAdapter } from "@pracht/vite-plugin";

export {
  createStaticServerEntryModule,
  staticAdapter,
  type StaticAdapterOptions,
} from "./static-entry.ts";
export { createStaticPreviewHandler, type StaticPreviewHandlerOptions } from "./static-preview.ts";
