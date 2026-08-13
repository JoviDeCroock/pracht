/** Stable facade for Pracht virtual-module source generation. */

export {
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
} from "./plugin-client-codegen.ts";
export { createPrachtDevModuleSource } from "./plugin-dev-codegen.ts";
export { createPrachtRegistryModuleSource } from "./plugin-registry-codegen.ts";
export { clearPagesAppSourceCache } from "./plugin-route-sources.ts";
export { createPrachtServerModuleSource } from "./plugin-server-codegen.ts";
