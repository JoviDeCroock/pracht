// The contract the factory returns, carried in this package's own declarations
// so a value of it can be named without importing `@pracht/vite-plugin`.
export type { PrachtAdapter } from "@pracht/vite-plugin";

export {
  createNodeRequestHandler,
  type NodeAdapterContextArgs,
  type NodeAdapterOptions,
  type NodeRequestHandler,
} from "./node-handler.ts";
export {
  createNodeServerEntryModule,
  nodeAdapter,
  type NodeServerEntryModuleOptions,
} from "./node-entry.ts";
// Static-file resolution helpers, shared with `@pracht/adapter-static`'s
// preview server: safe path resolution inside a root (NUL/backslash/symlink
// checks), clean-URL `index.html` fallback, and cache-control policy.
export { getCacheControl, resolveStaticFile, type StaticFileResult } from "./node-static.ts";
