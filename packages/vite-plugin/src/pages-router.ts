/**
 * Public pages-router entry point.
 *
 * Keep this module as a facade so package consumers have one stable import while
 * filesystem discovery, source analysis, route ordering, and code generation
 * can evolve independently.
 */
export { scanPagesDirectory } from "./pages-router/discovery.ts";
export { generatePagesManifestSource, generateRoutesFile } from "./pages-router/manifest.ts";
export type { PagesRouterOptions, ScannedPage } from "./pages-router/model.ts";
export { filePathToRoutePath, sortRoutes } from "./pages-router/route-path.ts";
