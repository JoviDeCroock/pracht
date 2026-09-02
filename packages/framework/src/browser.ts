export {
  buildHref,
  buildPathFromSegments,
  defineApp,
  group,
  matchApiRoute,
  matchAppRoute,
  matchRoutePath,
  resolveApiRoutes,
  resolveApp,
  route,
  routePathIsDynamic,
  timeRevalidate,
  webhookRevalidate,
} from "./app.ts";
// The package's browser condition resolves to this entry. Keep the deploy-base
// helpers here as well as in index.ts so generated and hand-written client
// modules can import them from "@pracht/core".
export { PRACHT_BASE, stripBase, withBase } from "./base.ts";
/**
 * Constraint factories are plain data builders with no server dependency, and
 * they are called *inside* `defineApp({ constraints })` — which means they run
 * in the client bundle too, because the manifest is the one module both
 * environments share. Omitting them here made a documented manifest feature a
 * silent, whole-app hydration failure.
 */
export {
  evaluateConstraints,
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
  EvaluateConstraintsOptions,
  ForbidRenderModeConstraint,
  RequireHeadConstraint,
  RequireMiddlewareConstraint,
  RequireRenderModeConstraint,
  RequireShellConstraint,
  RouteConstraint,
} from "./constraints.ts";
export { createHref } from "./href.ts";
/**
 * `defineFont` is pure data with no server dependency. Font modules are
 * imported by route components for `className`/`style`, so the helper must
 * resolve in the client bundle too.
 */
export { defineFont } from "./font.ts";
export type {
  DefineFontOptions,
  FontDisplay,
  FontSource,
  FontSourceInput,
  PrachtFont,
} from "./font.ts";
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
// Installed by the generated `virtual:pracht/capabilities` module — it owns
// the other CAPABILITY_SETTLED_EVENT dispatch path. See
// `runtime-capability-revalidate.ts` for why this is not in the provider.
export { ensureCapabilityRevalidation } from "./runtime-capability-revalidate.ts";
export {
  createEventStream,
  serializeEventStreamMessage,
  type EventStream,
  type EventStreamInit,
  type EventStreamMessage,
} from "./event-stream.ts";
export { isUpgradeRequest } from "./upgrade.ts";
export {
  useEventSource,
  type EventSourceState,
  type EventSourceStatus,
  type UseEventSourceOptions,
} from "./event-source-hook.ts";
export { forwardRef } from "./forwardRef.ts";
export { useIsHydrated } from "./hydration.ts";
export { Script } from "./script.ts";
export type { ScriptProps, ScriptStrategy } from "./script.ts";
export { defer, use } from "./defer.ts";
export type { Deferred } from "./defer.ts";
export { lazy, Suspense } from "./suspense.ts";
export { ErrorBoundary } from "./error-boundary.ts";
export type { ErrorBoundaryComponentProps } from "./error-boundary.ts";
export {
  Form,
  Link,
  PrachtRuntimeProvider,
  readHydrationState,
  startApp,
  useBlocker,
  useLocation,
  useNavigation,
  useParams,
  useRevalidate,
  useRouteData,
  useSearchParams,
  type Blocker,
  type BlockerArgs,
  type BlockerHistoryAction,
  type BlockerState,
  type ReadonlyURLSearchParams,
  type RegisterBlockerOptions,
  type ShouldBlockNavigation,
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
export { redirect, type RedirectOptions } from "./runtime-middleware.ts";
export { notFound, PrachtHttpError } from "./types.ts";

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
  // Type-only, so none of these reach the client bundle. They are the types
  // already-exported browser values and interfaces refer to — `FormProps`
  // and `createUseCapability` speak in capability envelopes, `RouteMeta`
  // in speculation and revalidate policies, `PrachtAppConfig` in agent trust
  // config — and without them client code cannot name what it receives.
  AgentPolicyMode,
  CapabilityBrowserCallOptions,
  CapabilityCallInputFor,
  CapabilityCallOptionsFor,
  CapabilityClientMethod,
  CapabilityConfirmationConfig,
  CapabilityEffect,
  CapabilityEffectFor,
  CapabilityEnvelope,
  CapabilityErrorCode,
  CapabilityErrorPayload,
  CapabilityInputFor,
  CapabilityIssue,
  CapabilityName,
  CapabilityOutputFor,
  HasRegisteredCapabilities,
  HttpCapabilityName,
  McpAuthConfig,
  McpProjectionConfig,
  McpTokenPrincipal,
  McpTokenVerifier,
  McpTokenVerifierModule,
  McpTokenVerifyArgs,
  NonDestructiveCapabilityName,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
  PrachtContextExtensions,
  PrachtRequestContext,
  RegisteredCapabilityName,
  RouteRevalidatePolicy,
  SpeculationConfig,
  SpeculationEagerness,
  SpeculationMode,
  SpeculationOption,
  WebBotAuthConfig,
  WebBotAuthStaticKey,
  WebhookRevalidatePolicy,
} from "./types.ts";
export type {
  FormProps,
  LinkHrefGuidance,
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
