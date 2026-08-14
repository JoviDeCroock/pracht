/**
 * Dev-only app-graph inspection facade.
 *
 * The page is standalone markup with inline styles so it remains available
 * even when the app's own Preact module graph is broken.
 */

export {
  buildAppGraph,
  detectApiExports,
  detectApiExportsStatic,
  detectApiMethods,
  serializeApiRoutes,
  serializeApiRoutesStatic,
  serializeAppRoutes,
  serializeCapabilities,
} from "./app-graph.ts";
export type {
  ApiRouteExports,
  AppGraph,
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphModuleAccess,
  AppGraphRoute,
  AppGraphStaticModuleAccess,
  SerializeApiRoutesOptions,
  SerializeCapabilitiesOptions,
} from "./app-graph.ts";
export { buildDevtoolsHtml } from "./devtools-page.ts";
export { DEVTOOLS_JSON_PATH, DEVTOOLS_PATH } from "./devtools-paths.ts";
