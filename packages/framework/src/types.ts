/**
 * Stable aggregate for the public `@pracht/core` type surface.
 *
 * Domain modules own the declarations; this file keeps existing framework
 * imports compatible without becoming the implementation home for each type.
 */
export type {
  AgentPolicyMode,
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
  McpProjectionConfig,
  PrachtAgentsConfig,
  WebBotAuthConfig,
  WebBotAuthStaticKey,
} from "./agent-types.ts";

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
  HttpMethod,
} from "./api-client-types.ts";

export type {
  ApiConfig,
  ApiRouteMatch,
  CatchAllRouteSegment,
  GroupDefinition,
  HrefRouteDefinition,
  ModuleRef,
  NotFoundConfig,
  NotFoundDefinition,
  ParamRouteSegment,
  PrachtApp,
  PrachtAppConfig,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteConfig,
  RouteDefinition,
  RouteMatch,
  RouteSegment,
  RouteTreeNode,
  StaticRouteSegment,
} from "./app-types.ts";

export type {
  NavigateOptions,
  LinkPrefetchStrategy,
  PrefetchStrategy,
  SpeculationConfig,
  SpeculationEagerness,
  SpeculationMode,
  SpeculationOption,
  UntypedRouteTarget,
} from "./navigation-types.ts";

export type {
  PrachtContextExtensions,
  PrachtRequestContext,
  Register,
  RegisteredContext,
} from "./registration.ts";

export type {
  HrefArgs,
  HrefFn,
  HrefOptions,
  RouteDataFor,
  RouteId,
  RouteParamsFor,
  RouteSearchFor,
  RouteTarget,
} from "./route-client-types.ts";

export type {
  BuildHrefOptions,
  RouteParamInput,
  RouteParams,
  SearchParamPrimitive,
  SearchParamsInput,
  SearchParamValue,
} from "./route-inputs.ts";

export type {
  GroupMeta,
  HydrationMode,
  IslandProps,
  IslandStrategy,
  LoaderCache,
  RenderMode,
  RouteMeta,
  RouteRevalidate,
  RouteRevalidatePolicy,
  TimeRevalidatePolicy,
  WebhookRevalidatePolicy,
} from "./route-policy-types.ts";

export type {
  ApiRouteArgs,
  ApiRouteHandler,
  ApiRouteModule,
  BaseRouteArgs,
  DataModule,
  ErrorBoundaryProps,
  HeadArgs,
  HeadAttributes,
  HeadMetadata,
  HeadersArgs,
  HeadScriptDescriptor,
  LoaderArgs,
  LoaderData,
  LoaderFn,
  LoaderLike,
  MaybePromise,
  MiddlewareArgs,
  MiddlewareFn,
  MiddlewareModule,
  MiddlewareNext,
  MiddlewareRoute,
  ModuleImporter,
  ModuleRegistry,
  RouteComponentProps,
  RouteLoaderData,
  RouteModule,
  ShellModule,
  ShellProps,
} from "./runtime-module-types.ts";

// Capability contracts live in the protocol-owning leaf package and are
// re-exported here so framework consumers retain one import surface.
export type {
  CapabilityAgentPolicy,
  CapabilityContext,
  CapabilityEffect,
  CapabilityEnvelope,
  CapabilityErrorCode,
  CapabilityErrorPayload,
  CapabilityExposure,
  CapabilityHttpExposure,
  CapabilityIssue,
  CapabilityRunArgs,
  CapabilityValidationResult,
  PrachtAgentIdentity,
} from "@pracht/capabilities";

export type {
  CapabilityBrowserCallOptions,
  CapabilityCallInputFor,
  CapabilityCallOptionsFor,
  CapabilityClientMethod,
  CapabilityEffectFor,
  CapabilityInputArgs,
  CapabilityInputFor,
  CapabilityModule,
  CapabilityName,
  CapabilityOutputFor,
  HasRegisteredCapabilities,
  HttpCapabilityName,
  NonDestructiveCapabilityName,
  PrachtCapability,
  RegisteredCapabilityName,
} from "./capability-types.ts";

export { notFound, PrachtHttpError } from "./http-errors.ts";
