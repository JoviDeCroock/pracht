import type { ComponentChildren, FunctionComponent } from "preact";

import type { RouteConstraint } from "./constraints.ts";

/**
 * Augment this interface to register your app's context type globally.
 * Once registered, all route args (`BaseRouteArgs`, `LoaderArgs`, etc.)
 * will use your context type automatically — no per-file generics needed.
 *
 * ```ts
 * // src/env.d.ts
 * declare module "@pracht/core" {
 *   interface Register {
 *     context: { env: Env; executionContext: ExecutionContext };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by users
export interface Register {}

export type RegisteredContext = Register extends { context: infer T } ? T : unknown;

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

export type RouteParams = Record<string, string>;

export type RouteParamInput = string | number | boolean;
export type SearchParamPrimitive = string | number | boolean;
export type SearchParamValue =
  | SearchParamPrimitive
  | null
  | undefined
  | readonly (SearchParamPrimitive | null | undefined)[];
export type SearchParamsInput = string | URLSearchParams | Record<string, SearchParamValue>;

export interface BuildHrefOptions {
  params?: Record<string, RouteParamInput>;
  search?: SearchParamsInput;
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

type RegisteredRouteMap = Register extends { routes: infer TRoutes }
  ? TRoutes extends Record<string, unknown>
    ? TRoutes
    : {}
  : {};

type HasRegisteredRoutes = keyof RegisteredRouteMap extends never ? false : true;
type EmptyRouteParams = Record<never, never>;
type IsEmptyRouteParams<TParams> = keyof TParams extends never ? true : false;

export type RouteId = HasRegisteredRoutes extends true
  ? Extract<keyof RegisteredRouteMap, string>
  : string;

export type RouteParamsFor<TRoute extends RouteId> = HasRegisteredRoutes extends true
  ? TRoute extends keyof RegisteredRouteMap
    ? RegisteredRouteMap[TRoute] extends { params: infer TParams }
      ? TParams extends Record<string, unknown>
        ? TParams
        : EmptyRouteParams
      : EmptyRouteParams
    : never
  : Record<string, RouteParamInput>;

export type RouteSearchFor<TRoute extends RouteId> = HasRegisteredRoutes extends true
  ? TRoute extends keyof RegisteredRouteMap
    ? RegisteredRouteMap[TRoute] extends { search: infer TSearch }
      ? TSearch
      : SearchParamsInput
    : never
  : SearchParamsInput;

export type RouteDataFor<TRoute extends RouteId> = HasRegisteredRoutes extends true
  ? TRoute extends keyof RegisteredRouteMap
    ? RegisteredRouteMap[TRoute] extends { data: infer TData }
      ? TData
      : unknown
    : never
  : unknown;

type TypedHrefOptions<TRoute extends RouteId> =
  IsEmptyRouteParams<RouteParamsFor<TRoute>> extends true
    ? {
        params?: never;
        search?: RouteSearchFor<TRoute>;
        hash?: string;
      }
    : {
        params: RouteParamsFor<TRoute>;
        search?: RouteSearchFor<TRoute>;
        hash?: string;
      };

export type HrefOptions<TRoute extends RouteId = RouteId> = HasRegisteredRoutes extends true
  ? TRoute extends RouteId
    ? TypedHrefOptions<TRoute>
    : never
  : BuildHrefOptions;

export type HrefArgs<TRoute extends RouteId = RouteId> = HasRegisteredRoutes extends true
  ? TRoute extends RouteId
    ? IsEmptyRouteParams<RouteParamsFor<TRoute>> extends true
      ? [options?: TypedHrefOptions<TRoute>]
      : [options: TypedHrefOptions<TRoute>]
    : never
  : [options?: BuildHrefOptions];

export type RouteTarget<TRoute extends RouteId = RouteId> = HasRegisteredRoutes extends true
  ? TRoute extends RouteId
    ? { route: TRoute } & TypedHrefOptions<TRoute>
    : never
  : { route: string } & BuildHrefOptions;

export type HrefFn = <TRoute extends RouteId>(route: TRoute, ...args: HrefArgs<TRoute>) => string;

type RegisteredApiRouteMap = Register extends { apiRoutes: infer TApiRoutes }
  ? TApiRoutes extends Record<string, unknown>
    ? TApiRoutes
    : {}
  : {};

type HasRegisteredApiRoutes = keyof RegisteredApiRouteMap extends never ? false : true;

/**
 * API route path templates registered by `pracht typegen` (e.g.
 * `"/api/items/:id"`). Falls back to `string` when no api routes are
 * registered so `apiFetch()` stays usable without codegen.
 */
export type ApiPath = HasRegisteredApiRoutes extends true
  ? Extract<keyof RegisteredApiRouteMap, string>
  : string;

type ApiRouteEntryFor<TPath> = TPath extends keyof RegisteredApiRouteMap
  ? RegisteredApiRouteMap[TPath]
  : never;

type ApiMethodMapFor<TPath> =
  ApiRouteEntryFor<TPath> extends { methods: infer TMethods } ? TMethods : {};

/** HTTP methods handled by the registered route, including default fallbacks. */
export type ApiMethodsFor<TPath extends ApiPath> = HasRegisteredApiRoutes extends true
  ? "default" extends keyof ApiMethodMapFor<TPath>
    ? HttpMethod
    : Extract<keyof ApiMethodMapFor<TPath>, HttpMethod> extends never
      ? HttpMethod
      : Extract<keyof ApiMethodMapFor<TPath>, HttpMethod>
  : HttpMethod;

type ApiMethodTypesFor<
  TPath extends ApiPath,
  TMethod,
> = TMethod extends keyof ApiMethodMapFor<TPath>
  ? ApiMethodMapFor<TPath>[TMethod]
  : "default" extends keyof ApiMethodMapFor<TPath>
    ? ApiMethodMapFor<TPath>["default"]
    : { body: unknown; query: unknown; output: unknown; params: unknown };

export type ApiBodyFor<TPath extends ApiPath, TMethod extends HttpMethod> = TMethod extends
  | "GET"
  | "HEAD"
  ? undefined
  : ApiMethodTypesFor<TPath, TMethod> extends { body: infer TBody }
    ? TBody
    : unknown;

export type ApiQueryFor<TPath extends ApiPath, TMethod extends HttpMethod> =
  ApiMethodTypesFor<TPath, TMethod> extends { query: infer TQuery } ? TQuery : unknown;

export type ApiOutputFor<TPath extends ApiPath, TMethod extends HttpMethod> = TMethod extends "HEAD"
  ? undefined
  : ApiMethodTypesFor<TPath, TMethod> extends { output: infer TOutput }
    ? TOutput
    : unknown;

export type ApiParamsFor<TPath extends ApiPath> = HasRegisteredApiRoutes extends true
  ? ApiRouteEntryFor<TPath> extends { params: infer TParams }
    ? TParams extends Record<string, unknown>
      ? TParams
      : EmptyRouteParams
    : EmptyRouteParams
  : Record<string, RouteParamInput>;

type ApiParamsSchemaInputFor<TPath extends ApiPath, TMethod extends HttpMethod> =
  ApiMethodTypesFor<TPath, TMethod> extends { params: infer TParams } ? TParams : unknown;

type ApiFetchMethodField<TMethod> = TMethod extends "GET"
  ? { method?: "GET" }
  : { method: TMethod };

type ContainsFileValue<TValue> = [Extract<TValue, Blob>] extends [never]
  ? TValue extends readonly (infer TEntry)[]
    ? [Extract<TEntry, Blob>] extends [never]
      ? false
      : true
    : false
  : true;

type ApiBodyAcceptsFormData<TBody> =
  TBody extends Record<string, unknown>
    ? true extends {
        [TKey in keyof TBody]-?: ContainsFileValue<NonNullable<TBody[TKey]>>;
      }[keyof TBody]
      ? true
      : false
    : false;

/**
 * A `File`/`Blob`-bearing body schema targets multipart form submissions.
 * JSON-encoding such a body would silently drop the file (`File` serializes
 * to `{}`), so `FormData` is accepted as the wire format for those routes.
 */
type ApiFetchBodyInput<TBody> =
  true extends ApiBodyAcceptsFormData<NonNullable<TBody>> ? TBody | FormData : TBody;

type ApiFetchBodyField<TBody> = unknown extends TBody
  ? { body?: unknown }
  : undefined extends TBody
    ? { body?: ApiFetchBodyInput<TBody> }
    : { body: ApiFetchBodyInput<TBody> };

type QueryWireValue = string | readonly string[];

/**
 * Query values cross the wire as URL search params: the server always hands
 * the query schema a string per key (or a string array for repeated keys). A
 * schema input with no string representation — `z.number()`, `z.boolean()` —
 * would type-check here yet fail validation on every request, so those keys
 * become a compile-time error instead. Inputs that accept strings
 * (`z.coerce.number()`, `z.enum([...])`, unions with a string arm) pass
 * through unchanged.
 */
type ApiQueryWireCheck<TQuery> =
  TQuery extends Record<string, unknown>
    ? {
        [TKey in keyof TQuery]: unknown extends TQuery[TKey]
          ? TQuery[TKey]
          : [Extract<NonNullable<TQuery[TKey]>, QueryWireValue>] extends [never]
            ? {
                readonly "Query values arrive as strings; give this key a schema input that accepts them (e.g. z.coerce.number())": never;
              }
            : TQuery[TKey];
      }
    : TQuery;

type ApiFetchQueryField<TQuery> = unknown extends TQuery
  ? { query?: SearchParamsInput }
  : Record<never, never> extends TQuery
    ? { query?: ApiQueryWireCheck<TQuery> }
    : { query: ApiQueryWireCheck<TQuery> };

type ApiParamWireError = {
  readonly "Route params arrive as strings; give this key a schema input that accepts them (e.g. z.coerce.number())": never;
};

/**
 * Route params are interpolated from convenient primitive inputs, but the
 * server always hands their string representation to the params schema. Keep
 * the ergonomic call-site type while rejecting schema keys that cannot accept
 * that wire value. Opaque schema inputs (`unknown`) remain permissive.
 */
type ApiParamsWireCheck<TPathParams, TSchemaInput> = unknown extends TSchemaInput
  ? TPathParams
  : TSchemaInput extends Record<string, unknown>
    ? {
        [TKey in keyof TPathParams]: TKey extends keyof TSchemaInput
          ? unknown extends TSchemaInput[TKey]
            ? TPathParams[TKey]
            : [Extract<NonNullable<TSchemaInput[TKey]>, string>] extends [never]
              ? ApiParamWireError
              : TPathParams[TKey]
          : TPathParams[TKey];
      }
    : { [TKey in keyof TPathParams]: ApiParamWireError };

type ApiFetchParamsField<
  TPath extends ApiPath,
  TMethod extends HttpMethod,
> = HasRegisteredApiRoutes extends true
  ? IsEmptyRouteParams<ApiParamsFor<TPath>> extends true
    ? { params?: never }
    : {
        params: ApiParamsWireCheck<ApiParamsFor<TPath>, ApiParamsSchemaInputFor<TPath, TMethod>>;
      }
  : { params?: Record<string, RouteParamInput> };

export interface ApiFetchBaseOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Custom fetch implementation (tests, server-to-server calls). */
  fetch?: typeof globalThis.fetch;
  /** Prefix for the request URL, e.g. an absolute origin during SSR. */
  baseUrl?: string;
}

export type ApiFetchOptions<
  TPath extends ApiPath = ApiPath,
  TMethod extends ApiMethodsFor<TPath> = ApiMethodsFor<TPath>,
> =
  TMethod extends ApiMethodsFor<TPath>
    ? ApiFetchBaseOptions &
        ApiFetchMethodField<TMethod> &
        ApiFetchBodyField<ApiBodyFor<TPath, TMethod>> &
        ApiFetchQueryField<ApiQueryFor<TPath, TMethod>> &
        ApiFetchParamsField<TPath, TMethod>
    : never;

export type ApiFetchArgs<TPath extends ApiPath, TMethod extends ApiMethodsFor<TPath>> =
  Record<never, never> extends ApiFetchOptions<TPath, TMethod>
    ? [options?: ApiFetchOptions<TPath, TMethod>]
    : [options: ApiFetchOptions<TPath, TMethod>];

export type DefaultApiMethod<TPath extends ApiPath> =
  "GET" extends ApiMethodsFor<TPath> ? "GET" : ApiMethodsFor<TPath>;

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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

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

// ---------------------------------------------------------------------------
// Agent trust layer (Web Bot Auth + destructive-capability confirmation)
//
// Everything in `agents` is plain serializable data — the app manifest is
// bundled into the client too, so no secrets and no functions belong here.
// Web Bot Auth keys are *public* Ed25519 keys; the confirmation secret comes
// from the environment (PRACHT_CONFIRMATION_SECRET) or
// `setCapabilityConfirmationSecret()`, never from the manifest.
// ---------------------------------------------------------------------------

export type AgentPolicyMode = "observe" | "require";

/** A statically configured agent verification key (public Ed25519 JWK material). */
export interface WebBotAuthStaticKey {
  /** Base64url raw Ed25519 public key — the JWK `x` member. */
  x: string;
  /**
   * Key id the agent sends as `keyid`. Defaults to the RFC 8037 JWK SHA-256
   * thumbprint computed from `x`, which is what Web Bot Auth agents send.
   */
  kid?: string;
  /** Label reported as `agentDomain` when the request has no Signature-Agent header. */
  agent?: string;
}

export interface WebBotAuthConfig {
  /**
   * App-wide default policy for capability HTTP endpoints.
   * - `"observe"` (default): verify and surface `context.agent`, serve everyone.
   * - `"require"`: unsigned/unverified requests to capability HTTP endpoints
   *   get a 401 envelope. Individual capabilities can override via `agentPolicy`.
   */
  policy?: AgentPolicyMode;
  /** Statically trusted keys (tests, air-gapped deploys, pinned agents). */
  keys?: WebBotAuthStaticKey[];
  /**
   * Origins (e.g. `"https://signature-agent.example"`) whose
   * `/.well-known/http-message-signatures-directory` may be fetched to
   * resolve unknown key ids. Fetching is allowlist-only: an unlisted
   * Signature-Agent fails verification instead of triggering a fetch
   * (fail closed, no SSRF surface).
   */
  directories?: string[];
  /** Allowed clock skew when checking `created`/`expires`, seconds. Default 60. */
  clockSkewSeconds?: number;
  /** Maximum accepted signature lifetime (`expires - created`), seconds. Default 86400 (24h, per draft guidance). */
  maxLifetimeSeconds?: number;
  /** In-memory TTL for fetched key directories, seconds. Default 300. */
  directoryCacheTtlSeconds?: number;
}

export interface CapabilityConfirmationConfig {
  /** Confirmation token TTL, seconds. Default 120. */
  ttlSeconds?: number;
  /**
   * Best-effort single-use enforcement via an in-memory, per-instance cache.
   * Stateless HMAC tokens cannot prevent replay across instances or
   * restarts — see docs/AGENT_TRUST.md for the honest limitations.
   */
  singleUse?: boolean;
}

export interface PrachtAgentsConfig {
  /** Verify RFC 9421 / Web Bot Auth agent signatures and surface `context.agent`. */
  webBotAuth?: WebBotAuthConfig;
  /** Prepare/commit confirmation flow options for destructive capabilities. */
  confirmation?: CapabilityConfirmationConfig;
}

/** Verified agent identity surfaced as `context.agent` when Web Bot Auth is enabled. */
export interface PrachtAgentIdentity {
  verified: true;
  /** Host of the agent's Signature-Agent directory URL (or the static key's `agent` label). */
  agentDomain: string | null;
  /** The `keyid` signature parameter (base64url JWK thumbprint). */
  keyId: string;
}

/** Structured audit event emitted for every capability dispatch. */
export interface CapabilityAuditEvent {
  capability: string;
  effect: CapabilityEffect;
  /** How the capability was invoked. */
  transport: "http" | "server";
  /** `"ok"` or the envelope error code (e.g. `"invalid_input"`, `"confirmation_required"`). */
  outcome: string;
  /** HTTP status the envelope maps to (also set for server-side invocation). */
  status: number;
  durationMs: number;
  /** Verified agent identity, `null` when unsigned/unverified or Web Bot Auth is off. */
  agent: PrachtAgentIdentity | null;
}

export type CapabilityAuditHook = (event: CapabilityAuditEvent) => void;

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

export interface ResolvedPrachtApp extends Omit<PrachtApp, "routes"> {
  routes: ResolvedRoute[];
  apiRoutes: ResolvedApiRoute[];
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

export interface MiddlewareArgs<TContext = RegisteredContext> extends BaseRouteArgs<TContext> {}

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
// The framework executes capabilities through this structural contract so
// `@pracht/core` never has to depend on the optional `@pracht/capabilities`
// package. `defineCapability()` returns objects satisfying `PrachtCapability`.
// ---------------------------------------------------------------------------

export type CapabilityEffect = "read" | "write" | "destructive";

export interface CapabilityIssue {
  path: string;
  message: string;
}

export type CapabilityValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; issues: CapabilityIssue[] };

export interface CapabilityHttpExposure {
  method: "POST";
  path?: string;
}

export interface CapabilityExposure {
  http: CapabilityHttpExposure | null;
  mcp: boolean;
  webmcp: boolean;
}

export interface CapabilityRunArgs<TContext = RegisteredContext> {
  input: unknown;
  context: TContext;
  request: Request;
  signal: AbortSignal;
}

export interface PrachtCapability<TContext = any> {
  kind: "capability";
  title: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  effect: CapabilityEffect;
  middleware: string[];
  expose: CapabilityExposure | null;
  /** Per-capability Web Bot Auth policy override; inherits the app default when unset. */
  agentPolicy?: "observe" | "require";
  run: (args: CapabilityRunArgs<TContext>) => MaybePromise<unknown>;
  /** Applies input defaults and validates against the input schema. */
  validateInput: (value: unknown) => CapabilityValidationResult;
  validateOutput: (value: unknown) => CapabilityValidationResult;
}

export interface CapabilityModule<TContext = any> {
  default: PrachtCapability<TContext>;
}

export interface CapabilityErrorPayload {
  code: string;
  message: string;
  issues?: CapabilityIssue[];
  /** Present on `confirmation_required` errors: pass it back via `x-pracht-confirm`. */
  confirmationToken?: string;
  /** Unix seconds when `confirmationToken` expires. */
  expiresAt?: number;
}

/** Result/error envelope shared by HTTP, WebMCP, and `invokeCapability()`. */
export type CapabilityEnvelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: CapabilityErrorPayload };

export class PrachtHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PrachtHttpError";
    this.status = status;
  }
}
