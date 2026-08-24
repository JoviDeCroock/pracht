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
/**
 * The deploy base (Vite `base`) and the helpers that move a path across it.
 * `<Link route>`, `href()`, and `apiFetch()` apply the base already; these are
 * for hand-written URLs — a root-absolute `<a href>`, a `fetch()` to your own
 * endpoint, an asset path built at runtime.
 */
export { PRACHT_BASE, stripBase, withBase } from "./base.ts";
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
  AppGraphStaticModuleAccess,
  AppGraphRoute,
  SerializeApiRoutesOptions,
  SerializeCapabilitiesOptions,
} from "./app-graph.ts";
export { filterPublicEnv, PRACHT_PUBLIC_ENV_PREFIX, publicEnv } from "./env.ts";
export type { PrachtPublicEnv, PrachtServerEnv, PublicEnvOf } from "./env.ts";
export {
  capabilityHttpPath,
  invokeCapability,
  matchCapabilityRoute,
  resolveAppCapabilities,
  setCapabilityAuditHook,
} from "./runtime-capabilities.ts";
export type { InvokeCapabilityContext, ResolvedCapability } from "./runtime-capabilities.ts";
export { resolveRegistryModule } from "./runtime-manifest.ts";
export { createCapabilityTestHost } from "./testing-capabilities.ts";
export type {
  CapabilityTestHost,
  CapabilityTestHostOptions,
  CapabilityTestInvokeOptions,
  CapabilityTestRequestOptions,
} from "./testing-capabilities.ts";
export { verifyAgentSignature } from "./runtime-agent-auth.ts";
export type { VerifyAgentSignatureOptions } from "./runtime-agent-auth.ts";
export {
  handleMcpRequest,
  MCP_CONFIRMATION_META_KEY,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  mcpExposedCapabilities,
  resolveMcpEndpoint,
} from "./runtime-mcp.ts";
export type { HandleMcpRequestOptions } from "./runtime-mcp.ts";
export {
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  setCapabilityConfirmationSecret,
} from "./runtime-confirmation.ts";
export { createUseCapability, type CapabilityHookResult } from "./capability-hook.ts";
export {
  createMemoryApprovalStore,
  setCapabilityApprovalStore,
  setCapabilityApprovalPrincipalResolver,
} from "./runtime-approval.ts";
export type { MemoryApprovalStoreOptions } from "./runtime-approval.ts";
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
export { Suspense, lazy } from "preact-suspense";
export {
  applyDefaultSecurityHeaders,
  Form,
  formatServerTimingHeader,
  Link,
  handlePrachtRequest,
  readHydrationState,
  startApp,
  useLocation,
  useNavigation,
  useParams,
  useRevalidate,
  useRouteData,
  useSearchParams,
  PrachtRuntimeProvider,
  type ReadonlyURLSearchParams,
} from "./runtime.ts";
export { prefetch, type PrefetchFn } from "./prefetch-api.ts";
export { buildStaticFallbackHtml, prerenderApp } from "./prerender.ts";
export {
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  getTimeRevalidateSeconds,
  hasWebhookRevalidate,
  isAuthorizedRevalidationRequest,
  isCacheableISGResponse,
  isDangerousPrerenderHeader,
  jsonResponse,
  normalizeRouteRevalidate,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  PRACHT_REVALIDATE_TOKEN_HEADER,
  readRevalidationRequest,
  resolveRevalidationToken,
  RevalidationReport,
  classifyRevalidationSkip,
  type RevalidationDetail,
  type RevalidationOutcome,
  type RevalidationReportBody,
  type RevalidationSkipReason,
  type RevalidationSingleFlight,
} from "./revalidation.ts";
export { PRACHT_GRAPH_ONLY_ENV } from "./runtime-constants.ts";
export { redirect, type RedirectOptions } from "./runtime-middleware.ts";
export { initClientRouter, useNavigate } from "./router.ts";
export {
  registerServerIslands,
  setIslandsClientEntryUrl,
  validateIslandProps,
  type IslandCapture,
  type IslandDescriptor,
  type IslandUsage,
} from "./islands-server.ts";
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
  AgentPolicyMode,
  BaseRouteArgs,
  CapabilityApprovalConsumeFailure,
  CapabilityApprovalConsumeResult,
  CapabilityApprovalPrincipalArgs,
  CapabilityApprovalPrincipalResolver,
  CapabilityApprovalRecord,
  CapabilityApprovalState,
  CapabilityApprovalStore,
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityConfirmationConfig,
  CapabilityEffect,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
  WebBotAuthConfig,
  WebBotAuthStaticKey,
  CapabilityContext,
  CapabilityEnvelope,
  CapabilityErrorCode,
  CapabilityErrorPayload,
  CapabilityExposure,
  CapabilityHttpExposure,
  CapabilityBrowserCallOptions,
  CapabilityCallInputFor,
  CapabilityCallOptionsFor,
  CapabilityClientMethod,
  CapabilityEffectFor,
  CapabilityInputArgs,
  CapabilityInputFor,
  CapabilityIssue,
  CapabilityModule,
  CapabilityName,
  CapabilityOutputFor,
  NonDestructiveCapabilityName,
  CapabilityRunArgs,
  CapabilityValidationResult,
  HasRegisteredCapabilities,
  HttpCapabilityName,
  McpProjectionConfig,
  PrachtContextExtensions,
  PrachtRequestContext,
  RegisteredCapabilityName,
  PrachtCapability,
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
  RouteRevalidatePolicy,
  RouteSearchFor,
  RouteTarget,
  RouteTreeNode,
  SearchParamPrimitive,
  SearchParamValue,
  SearchParamsInput,
  ShellModule,
  ShellProps,
  SpeculationConfig,
  SpeculationEagerness,
  SpeculationMode,
  SpeculationOption,
  TimeRevalidatePolicy,
  WebhookRevalidatePolicy,
  PrachtApp,
  PrachtAppConfig,
} from "./types.ts";
export type {
  FormProps,
  HandlePrachtRequestOptions,
  LinkProps,
  Location,
  Navigation,
  NavigationLocation,
  PrachtPhaseTimings,
  PrachtRuntimeDiagnosticPhase,
  PrachtRuntimeDiagnostics,
  RouteStateResult,
  SerializedRouteError,
  StartAppOptions,
  PrachtHydrationState,
} from "./runtime.ts";
export type {
  ISGManifestEntry,
  PrerenderAppOptions,
  PrerenderAppResult,
  PrerenderResult,
} from "./prerender.ts";
export type { InitClientRouterOptions, NavigateFn } from "./router.ts";
