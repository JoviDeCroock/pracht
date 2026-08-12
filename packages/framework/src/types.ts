import type { ComponentChildren, FunctionComponent } from "preact";

import type { PrachtAgentsConfig } from "./agent-types.ts";
import type { HttpMethod } from "./api-client-types.ts";
import type { CapabilityModule } from "./capability-types.ts";
import type { RouteConstraint } from "./constraints.ts";
import type { PrachtRequestContext, RegisteredContext } from "./registration.ts";
import type { RouteParams } from "./route-inputs.ts";

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

export type RenderMode = "spa" | "ssr" | "ssg" | "isg";

/**
 * Per-route hydration mode.
 *
 * - `"full"` (default) — the whole page tree hydrates and the client router
 *   takes over navigation. Existing behavior, zero change.
 * - `"islands"` — only components from the islands directory (`src/islands/`)
 *   hydrate; the rest of the page ships no JavaScript. Navigation to and from
 *   these routes is regular full-document (MPA-style) navigation.
 * - `"none"` — fully static output; no JavaScript is injected at all.
 */
export type HydrationMode = "full" | "islands" | "none";

/**
 * Hydration strategy for one island usage, passed via the `client` prop:
 *
 * - `"load"` (default) — hydrate as soon as the islands bootstrap runs.
 * - `"idle"` — hydrate in a `requestIdleCallback`.
 * - `"visible"` — hydrate when the island scrolls into view
 *   (`IntersectionObserver`).
 */
export type IslandStrategy = "load" | "idle" | "visible";

/**
 * Props accepted by every island component usage on the server. Intersect
 * with your own props type: `function Counter(props: CounterProps & IslandProps)`.
 * `client` is consumed by the framework and never reaches the component.
 */
export interface IslandProps {
  client?: IslandStrategy;
}

/** @internal Wide route target used by framework implementations before public type narrowing. */
export interface UntypedRouteTarget {
  route: string;
  params?: Record<string, unknown>;
  search?: unknown;
  hash?: string;
}

export interface NavigateOptions {
  replace?: boolean;
  /**
   * Keep the current scroll position after the navigation commits instead of
   * scrolling to the top (or to the target `#hash` element).
   */
  preserveScroll?: boolean;
  /**
   * Wrap this navigation's DOM commit in `document.startViewTransition()`
   * when the browser supports it. Overrides the app-level
   * `viewTransitions` default for this navigation.
   */
  viewTransition?: boolean;
}

export interface HrefRouteDefinition {
  id?: string;
  path: string;
  segments?: readonly RouteSegment[];
}

/**
 * A reference to a module file — either a plain string path or a lazy import
 * function. Using `() => import("./path")` enables IDE click-to-navigate.
 * The vite plugin transforms import functions back to strings at build time.
 */
export type ModuleRef = string | (() => Promise<any>);

export interface TimeRevalidatePolicy {
  kind: "time";
  seconds: number;
}

export interface WebhookRevalidatePolicy {
  kind: "webhook";
}

export type RouteRevalidatePolicy = TimeRevalidatePolicy | WebhookRevalidatePolicy;

export type RouteRevalidate = RouteRevalidatePolicy | readonly RouteRevalidatePolicy[];

export type ApiRouteArgs<TContext = RegisteredContext> = Omit<BaseRouteArgs<TContext>, "route"> & {
  route: ResolvedApiRoute;
};

export type ApiRouteHandler<TContext = RegisteredContext> = (
  args: ApiRouteArgs<TContext>,
) => MaybePromise<Response>;

export interface ApiRouteModule<TContext = any> {
  default?: ApiRouteHandler<TContext>;
  GET?: ApiRouteHandler<TContext>;
  POST?: ApiRouteHandler<TContext>;
  PUT?: ApiRouteHandler<TContext>;
  PATCH?: ApiRouteHandler<TContext>;
  DELETE?: ApiRouteHandler<TContext>;
  HEAD?: ApiRouteHandler<TContext>;
  OPTIONS?: ApiRouteHandler<TContext>;
}

export interface ResolvedApiRoute {
  path: string;
  file: string;
  segments: RouteSegment[];
}

export interface ApiRouteMatch {
  route: ResolvedApiRoute;
  params: RouteParams;
  pathname: string;
}

export type PrefetchStrategy = "none" | "hover" | "viewport" | "intent";

/**
 * Browser cache duration for route-state loader responses, in seconds.
 * `false` and `0` disable storage with `Cache-Control: no-store`.
 */
export type LoaderCache = number | false;

/**
 * Per-link prefetch strategy accepted by `<Link prefetch>`. Extends the
 * route-level strategies with `"render"`, which prefetches as soon as the
 * link is rendered.
 */
export type LinkPrefetchStrategy = PrefetchStrategy | "render";

/**
 * Browser-native speculation rules. Emitted as `<script type="speculationrules">`
 * in the SSR/SSG HTML. Complements the JS-based `prefetch` strategies — those
 * fetch route-state JSON for SPA navigation; this opts the browser into HTML
 * prefetch or full prerender so a click can swap to an already-rendered document.
 *
 * - `prefetch`: browser fetches the page HTML on intent (default eagerness
 *   `moderate` — ~hover/touchstart). Useful for full-page navigations and
 *   middle-click / new-tab opens.
 * - `prerender`: browser fully renders the page (running its JS) in the
 *   background; click navigates instantly. The SPA click handler skips
 *   prerender-marked routes so the browser can activate the prerendered
 *   document instead of intercepting the click. Default eagerness
 *   `conservative` (touchstart / mousedown).
 */
export type SpeculationMode = "prefetch" | "prerender";

export type SpeculationEagerness = "immediate" | "eager" | "moderate" | "conservative";

export interface SpeculationConfig {
  mode: SpeculationMode;
  eagerness?: SpeculationEagerness;
}

export type SpeculationOption = SpeculationMode | SpeculationConfig;

export interface RouteMeta {
  id?: string;
  shell?: string;
  render?: RenderMode;
  hydration?: HydrationMode;
  /** Declare that middleware negotiates a Markdown representation for this route. */
  markdown?: boolean;
  middleware?: string[];
  revalidate?: RouteRevalidate;
  loaderCache?: LoaderCache;
  prefetch?: PrefetchStrategy;
  speculation?: SpeculationOption;
  hasLoader?: boolean;
}

export interface GroupMeta {
  shell?: string;
  render?: RenderMode;
  hydration?: HydrationMode;
  middleware?: string[];
  loaderCache?: LoaderCache;
  pathPrefix?: string;
  speculation?: SpeculationOption;
}

export interface ApiConfig {
  middleware?: string[];
  /**
   * When `true` (the default), state-changing API requests
   * (POST/PUT/PATCH/DELETE) are rejected unless the browser signals an
   * exact same-origin fetch (`Sec-Fetch-Site: same-origin`) or the request
   * Origin/Referer matches the request URL's origin. `same-site` is not
   * accepted by default because sibling subdomains can be attacker-controlled.
   * Set to `false` to opt out if you build your own CSRF protection into middleware.
   */
  requireSameOrigin?: boolean;
}

export interface RouteConfig extends RouteMeta {
  component: ModuleRef;
  loader?: ModuleRef;
}

/**
 * App-level not-found page. Rendered with a 404 status when a request matches
 * no page route, and when a loader/middleware throws a 404 (`notFound()`).
 *
 * It is deliberately *not* a route: it never participates in path matching,
 * so it cannot shadow static assets, API routes, or a later-registered page —
 * the failure mode of the catch-all (`route("/*", ...)`) pattern it replaces.
 * It is also excluded from typed routes, prefetching, speculation rules, and
 * SSG/ISG prerendering.
 */
export interface NotFoundConfig {
  component: ModuleRef;
  /** Separate loader module, mirroring `route({ component, loader })`. */
  loader?: ModuleRef;
  shell?: string;
  middleware?: string[];
  hydration?: HydrationMode;
}

/** `NotFoundConfig` with module refs resolved to file paths. */
export interface NotFoundDefinition {
  file: string;
  loaderFile?: string;
  hasLoader?: boolean;
  shell?: string;
  middleware?: string[];
  hydration?: HydrationMode;
}

export interface RouteDefinition extends RouteMeta {
  kind: "route";
  path: string;
  file: string;
  loaderFile?: string;
}

export interface GroupDefinition {
  kind: "group";
  meta: GroupMeta;
  routes: RouteTreeNode[];
}

export type RouteTreeNode = RouteDefinition | GroupDefinition;

export interface PrachtAppConfig {
  shells?: Record<string, ModuleRef>;
  middleware?: Record<string, ModuleRef>;
  /**
   * Named capabilities defined with `defineCapability()` from
   * `@pracht/capabilities`, registered like shells and middleware:
   * `{ "notes.search": () => import("./capabilities/notes-search.ts") }`.
   * Capability modules are server-only and private by default — a capability
   * without an `expose` config is only callable via `invokeCapability()`.
   */
  capabilities?: Record<string, ModuleRef>;
  /**
   * Agent trust configuration: Web Bot Auth verification policy/keys and the
   * destructive-capability confirmation flow. Serializable data only.
   */
  agents?: PrachtAgentsConfig;
  api?: ApiConfig;
  routes: RouteTreeNode[];
  /**
   * Page rendered (with a 404 status) when no route matches, and when a
   * loader or middleware throws a 404. See {@link NotFoundConfig}.
   */
  notFound?: ModuleRef | NotFoundConfig;
  /**
   * Declarative invariants over the resolved route graph (e.g.
   * `requireMiddleware("/app/**", "auth")`). Enforced deterministically by
   * `pracht verify`; violations fail verification.
   */
  constraints?: RouteConstraint[];
  /**
   * Enable the View Transitions API for every client navigation by default.
   * Individual navigations can still opt out via
   * `navigate(to, { viewTransition: false })`. Ignored in browsers without
   * `document.startViewTransition` support.
   */
  viewTransitions?: boolean;
}

export interface PrachtApp {
  shells: Record<string, string>;
  middleware: Record<string, string>;
  capabilities: Record<string, string>;
  agents?: PrachtAgentsConfig;
  api: ApiConfig;
  routes: RouteTreeNode[];
  notFound?: NotFoundDefinition;
  constraints?: RouteConstraint[];
  viewTransitions?: boolean;
}

export interface StaticRouteSegment {
  type: "static";
  value: string;
}

export interface ParamRouteSegment {
  type: "param";
  name: string;
}

export interface CatchAllRouteSegment {
  type: "catchall";
  name: string;
}

export type RouteSegment = StaticRouteSegment | ParamRouteSegment | CatchAllRouteSegment;

export interface ResolvedRoute extends Omit<RouteMeta, "middleware"> {
  path: string;
  file: string;
  loaderFile?: string;
  shell?: string;
  shellFile?: string;
  middleware: string[];
  middlewareFiles: string[];
  segments: RouteSegment[];
}

export interface ResolvedPrachtApp extends Omit<PrachtApp, "notFound" | "routes"> {
  routes: ResolvedRoute[];
  apiRoutes: ResolvedApiRoute[];
  /**
   * The not-found page as a route-shaped record so the render pipeline can
   * treat it like any other route. It is never present in `routes`, so it
   * never matches a URL.
   */
  notFound?: ResolvedRoute;
}

export interface RouteMatch {
  route: ResolvedRoute;
  params: RouteParams;
  pathname: string;
}

export interface BaseRouteArgs<TContext = RegisteredContext> {
  request: Request;
  params: RouteParams;
  context: TContext;
  signal: AbortSignal;
  url: URL;
  route: ResolvedRoute;
}

export interface LoaderArgs<TContext = RegisteredContext> extends BaseRouteArgs<TContext> {}

/** The matched page or API route whose middleware chain is running. */
export type MiddlewareRoute = ResolvedRoute | ResolvedApiRoute;

/**
 * Middleware wraps both page and API routes. Narrow `route` by checking for
 * page-only metadata such as `middlewareFiles` before reading those fields.
 */
export type MiddlewareArgs<TContext = RegisteredContext> = Omit<
  BaseRouteArgs<TContext>,
  "route"
> & {
  route: MiddlewareRoute;
};

export type HeadAttributes = Record<string, string | undefined>;

export interface HeadScriptDescriptor extends HeadAttributes {
  children?: string;
}

export interface HeadMetadata {
  title?: string;
  lang?: string;
  meta?: HeadAttributes[];
  link?: HeadAttributes[];
  script?: HeadScriptDescriptor[];
}

export type MaybePromise<T> = T | Promise<T>;

export type LoaderLike = ((args: LoaderArgs<any>) => unknown) | undefined;

export type LoaderData<TLoader extends LoaderLike> = TLoader extends (
  ...args: any[]
) => infer TResult
  ? Awaited<TResult>
  : never;

/**
 * Extract loader data from a route module type. `pracht typegen` uses this to
 * register per-route loader data on `Register["routes"]`. When a separate
 * loader module is wired via the manifest (`loader: () => import(...)`), pass
 * it first and the route module second — the loader module wins, matching the
 * runtime's resolution order. Modules without a `loader` export resolve to
 * `undefined`, mirroring the data a loaderless route receives.
 */
export type RouteLoaderData<TModule, TFallbackModule = TModule> = TModule extends {
  loader: (...args: any[]) => infer TResult;
}
  ? Awaited<TResult>
  : TFallbackModule extends { loader: (...args: any[]) => infer TFallbackResult }
    ? Awaited<TFallbackResult>
    : undefined;

export interface HeadArgs<
  TLoader extends LoaderLike = undefined,
  TContext = any,
> extends BaseRouteArgs<TContext> {
  data: LoaderData<TLoader>;
}

export interface HeadersArgs<
  TLoader extends LoaderLike = undefined,
  TContext = any,
> extends BaseRouteArgs<TContext> {
  data: LoaderData<TLoader>;
}

export interface RouteComponentProps<TLoader extends LoaderLike = undefined> {
  data: LoaderData<TLoader>;
  params: RouteParams;
}

export interface ErrorBoundaryProps {
  error: Error & { diagnostics?: unknown; status?: number };
}

export interface ShellProps {
  children: ComponentChildren;
}

export type LoaderFn<TContext = any, TData = unknown> = (
  args: LoaderArgs<TContext>,
) => MaybePromise<TData>;

export interface RouteModule<TContext = any, TLoader extends LoaderLike = undefined> {
  loader?: LoaderFn<TContext>;
  head?: (args: HeadArgs<TLoader, TContext>) => MaybePromise<HeadMetadata>;
  headers?: (args: HeadersArgs<TLoader, TContext>) => MaybePromise<HeadersInit>;
  Component?: FunctionComponent<RouteComponentProps<TLoader>>;
  default?: FunctionComponent<RouteComponentProps<TLoader>>;
  ErrorBoundary?: FunctionComponent<ErrorBoundaryProps>;
  getStaticPaths?: () => MaybePromise<RouteParams[]>;
  // Raw markdown served when a client requests `Accept: text/markdown`
  // (Markdown-for-Agents). The runtime returns this string with
  // `Content-Type: text/markdown` instead of rendering the component.
  markdown?: string;
}

export interface ShellModule<TContext = any> {
  Shell: FunctionComponent<ShellProps>;
  Loading?: FunctionComponent;
  ErrorBoundary?: FunctionComponent<ErrorBoundaryProps>;
  head?: (args: BaseRouteArgs<TContext>) => MaybePromise<HeadMetadata>;
  headers?: (args: BaseRouteArgs<TContext>) => MaybePromise<HeadersInit>;
}

export type MiddlewareNext = () => Promise<Response>;

export type MiddlewareFn<TContext = any> = (
  args: MiddlewareArgs<TContext>,
  next: MiddlewareNext,
) => MaybePromise<Response>;

export interface MiddlewareModule<TContext = any> {
  middleware: MiddlewareFn<TContext>;
}

export type ModuleImporter<TModule = unknown> = () => Promise<TModule>;

export interface DataModule<TContext = any> {
  loader?: LoaderFn<TContext>;
}

export interface ModuleRegistry {
  routeModules?: Record<string, ModuleImporter<RouteModule>>;
  shellModules?: Record<string, ModuleImporter<ShellModule>>;
  middlewareModules?: Record<string, ModuleImporter<MiddlewareModule>>;
  apiModules?: Record<string, ModuleImporter<ApiRouteModule>>;
  dataModules?: Record<string, ModuleImporter<DataModule>>;
  capabilityModules?: Record<string, ModuleImporter<CapabilityModule>>;
}

// ---------------------------------------------------------------------------
// Capabilities
//
// The contract types live in `@pracht/capabilities` — the protocol-owning
// leaf package — and are re-exported here so framework consumers keep one
// import surface. `PrachtCapability` is the erased-generics view of
// `defineCapability()`'s return value that the runtime executes.
// ---------------------------------------------------------------------------

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

export class PrachtHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PrachtHttpError";
    this.status = status;
  }
}

/**
 * The 404 a loader or middleware throws when the thing it was asked for does
 * not exist:
 *
 * ```ts
 * const post = await getPost(params.slug);
 * if (!post) throw notFound();
 * ```
 *
 * Returns the error instead of throwing it so the throw stays visible to
 * readers and to TypeScript's control-flow analysis (same shape as
 * `redirect()`). The response renders the app's `notFound` page when one is
 * configured and the route exports no `ErrorBoundary`.
 */
export function notFound(message = "Not found"): PrachtHttpError {
  return new PrachtHttpError(404, message);
}
