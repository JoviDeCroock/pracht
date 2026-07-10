export {
  buildHref,
  buildPathFromSegments,
  defineApp,
  group,
  matchAppRoute,
  resolveApp,
  route,
  timeRevalidate,
} from "./app.ts";
export { createHref } from "./href.ts";
export { forwardRef } from "./forwardRef.ts";
export { useIsHydrated } from "./hydration.ts";
export { Suspense, lazy } from "preact-suspense";
export {
  Form,
  Link,
  PrachtRuntimeProvider,
  readHydrationState,
  startApp,
  useLocation,
  useNavigation,
  useParams,
  useRevalidate,
  useRouteData,
} from "./runtime-hooks.ts";
export { prefetch, type PrefetchFn } from "./prefetch-api.ts";

/**
 * Browser stub for the server-only `invokeCapability()`. Route modules import
 * it for their loaders; the client transform strips the loader, but the named
 * import can survive when the statement also imports client hooks. This stub
 * keeps the capability pipeline out of client bundles and fails loudly if it
 * is ever called in the browser.
 */
export async function invokeCapability(): Promise<never> {
  throw new Error(
    "invokeCapability() is server-only. In the browser, call the HTTP projection " +
      'via callCapability from "virtual:pracht/capabilities" instead.',
  );
}
export { fetchPrachtRouteState, parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
export { initClientRouter, useNavigate } from "./router.ts";
export { redirect, type RedirectOptions } from "./runtime-middleware.ts";
export { PrachtHttpError } from "./types.ts";

export type {
  ApiConfig,
  ApiRouteArgs,
  ApiRouteHandler,
  Register,
  BuildHrefOptions,
  ApiRouteMatch,
  ApiRouteModule,
  BaseRouteArgs,
  DataModule,
  ErrorBoundaryProps,
  GroupDefinition,
  GroupMeta,
  HrefArgs,
  HrefFn,
  HrefOptions,
  HrefRouteDefinition,
  HeadArgs,
  HeadAttributes,
  HeadMetadata,
  HeadScriptDescriptor,
  HeadersArgs,
  HttpMethod,
  LoaderArgs,
  LoaderData,
  LoaderFn,
  MiddlewareArgs,
  MiddlewareFn,
  MiddlewareModule,
  MiddlewareNext,
  ModuleImporter,
  ModuleRef,
  NavigateOptions,
  PrefetchStrategy,
  LinkPrefetchStrategy,
  ModuleRegistry,
  RenderMode,
  HydrationMode,
  IslandStrategy,
  IslandProps,
  ResolvedApiRoute,
  ResolvedRoute,
  ResolvedPrachtApp,
  RouteComponentProps,
  RouteConfig,
  RouteDefinition,
  RouteId,
  RouteMatch,
  RouteMeta,
  RouteModule,
  RouteParamInput,
  RouteParams,
  RouteParamsFor,
  RouteDataFor,
  RouteLoaderData,
  RouteRevalidate,
  RouteSearchFor,
  RouteTarget,
  RouteTreeNode,
  SearchParamPrimitive,
  SearchParamValue,
  SearchParamsInput,
  ShellModule,
  ShellProps,
  TimeRevalidatePolicy,
  PrachtApp,
  PrachtAppConfig,
} from "./types.ts";
export type {
  FormProps,
  LinkProps,
  Location,
  Navigation,
  NavigationLocation,
  PrachtHydrationState,
  StartAppOptions,
} from "./runtime-hooks.ts";
export type { RouteStateResult } from "./runtime-client-fetch.ts";
export type { SerializedRouteError } from "./runtime-errors.ts";
export type { InitClientRouterOptions, NavigateFn } from "./router.ts";
