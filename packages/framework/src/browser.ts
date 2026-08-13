export {
  buildHref,
  buildPathFromSegments,
  defineApp,
  group,
  matchAppRoute,
  resolveApp,
  route,
  timeRevalidate,
  webhookRevalidate,
} from "./app.ts";
/**
 * Constraint factories are plain data builders with no server dependency, and
 * they are called *inside* `defineApp({ constraints })` — which means they run
 * in the client bundle too, because the manifest is the one module both
 * environments share. Omitting them here made a documented manifest feature a
 * silent, whole-app hydration failure.
 */
export {
  forbidRenderMode,
  matchRoutePattern,
  requireHead,
  requireMiddleware,
  requireRenderMode,
  requireShell,
} from "./constraints.ts";
export type {
  ConstraintRoute,
  ConstraintViolation,
  ForbidRenderModeConstraint,
  RequireHeadConstraint,
  RequireMiddlewareConstraint,
  RequireRenderModeConstraint,
  RequireShellConstraint,
  RouteConstraint,
} from "./constraints.ts";
export { createHref } from "./href.ts";
export {
  apiValidationErrorResponse,
  defineApi,
  formDataToRecord,
  isApiValidationErrorBody,
  json,
  searchParamsToRecord,
  validateStandardSchema,
} from "./api-validation.ts";
export type {
  ApiHandlerTypes,
  ApiJsonPrimitive,
  ApiJsonValue,
  ApiRouteMethodMap,
  ApiRouteSchemas,
  ApiValidationErrorBody,
  ApiValidationIssue,
  ApiValidationPathSegment,
  ApiValidationSource,
  DefineApiConfig,
  TypedJsonResponse,
  ValidatedApiArgs,
  ValidatedApiHandler,
} from "./api-validation.ts";
export { apiFetch, ApiFetchError } from "./api-fetch.ts";
export type {
  ApiBodyFor,
  ApiFetchArgs,
  ApiFetchBaseOptions,
  ApiFetchOptions,
  ApiMethodsFor,
  ApiOutputFor,
  ApiParamsFor,
  ApiPath,
  ApiQueryFor,
  DefaultApiMethod,
} from "./types.ts";
export { filterPublicEnv, PRACHT_PUBLIC_ENV_PREFIX, publicEnv } from "./env.ts";
export type { PrachtPublicEnv, PrachtServerEnv, PublicEnvOf } from "./env.ts";
// The generated `virtual:pracht/capabilities` module binds this to its
// `callCapability` to produce `useCapability`. It must be reachable from the
// browser entry — that is the one the client build resolves `@pracht/core` to.
export { createUseCapability, type CapabilityHookResult } from "./capability-hook.ts";
export { forwardRef } from "./forwardRef.ts";
export { useIsHydrated } from "./hydration.ts";
export { Script } from "./script.ts";
export type { ScriptProps, ScriptStrategy } from "./script.ts";
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
  useSearchParams,
  type ReadonlyURLSearchParams,
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

/** Browser stub for the server-only `createCapabilityTestHost()` — see above. */
export function createCapabilityTestHost(): never {
  throw new Error(
    "createCapabilityTestHost() is server-only. Import it in Node-based tests, " +
      "not in browser code.",
  );
}
export { fetchPrachtRouteState, parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
export { initClientRouter, useNavigate } from "./router.ts";
export { redirect, type RedirectOptions } from "./runtime-redirect.ts";
export { notFound, PrachtHttpError } from "./http-errors.ts";

export type {
  ApiConfig,
  ApiRouteArgs,
  ApiRouteHandler,
  Register,
  RegisteredContext,
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
  LoaderCache,
  MiddlewareArgs,
  MiddlewareFn,
  MiddlewareModule,
  MiddlewareNext,
  MiddlewareRoute,
  ModuleImporter,
  ModuleRef,
  NotFoundConfig,
  NotFoundDefinition,
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
