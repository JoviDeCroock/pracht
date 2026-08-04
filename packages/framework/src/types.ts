import type {
  Capability,
  CapabilityAgentPolicy,
  CapabilityEffect,
  PrachtAgentIdentity,
} from "@pracht/capabilities";
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

/**
 * Fields the framework itself surfaces on the request context, merged into
 * the app-registered context type so loaders, middleware, API routes, and
 * capabilities all see them without casts.
 */
export interface PrachtContextExtensions {
  /**
   * Verified agent identity (Web Bot Auth); `null` when the request is
   * unsigned or fails verification, absent when `defineApp({ agents })` is
   * not configured.
   */
  agent?: PrachtAgentIdentity | null;
}

export type RegisteredContext = (Register extends { context: infer T } ? T : unknown) &
  PrachtContextExtensions;

/**
 * The request context as application code receives it — the registered
 * context plus the framework-surfaced fields. Use it to type standalone
 * functions (e.g. the third `defineCapability()` generic).
 */
export type PrachtRequestContext = RegisteredContext;

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

// ---------------------------------------------------------------------------
// Agent trust layer (Web Bot Auth + destructive-capability confirmation)
//
// Everything in `agents` is plain serializable data — the app manifest is
// bundled into the client too, so no secrets and no functions belong here.
// Web Bot Auth keys are *public* Ed25519 keys; the confirmation secret comes
// from the environment (PRACHT_CONFIRMATION_SECRET) or
// `setCapabilityConfirmationSecret()`, never from the manifest.
// ---------------------------------------------------------------------------

export type AgentPolicyMode = CapabilityAgentPolicy;

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

/** Structured audit event emitted for every capability dispatch. */
export interface CapabilityAuditEvent {
  capability: string;
  effect: CapabilityEffect;
  /**
   * How the capability was invoked. `"webmcp"` reflects the transport marker
   * the generated WebMCP shim sends with its dispatches — informational, not
   * a trust signal (any HTTP client can send the header).
   */
  transport: "http" | "server" | "webmcp";
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

export type PrachtCapability<TContext = any> = Capability<any, unknown, TContext>;

export interface CapabilityModule<TContext = any> {
  default: PrachtCapability<TContext>;
}

/**
 * `pracht typegen` generates capability input/output types from the JSON
 * Schemas in the app's capability graph and registers them on
 * `Register["capabilities"]`, mirroring how route typegen registers
 * `Register["routes"]`. Once registered, `invokeCapability()` (and the
 * browser's `callCapability()`) infer input and output types from the
 * capability name — no per-call generics needed.
 */
type RegisteredCapabilityMap = Register extends { capabilities: infer TCapabilities }
  ? TCapabilities extends Record<string, unknown>
    ? TCapabilities
    : {}
  : {};

/**
 * Whether the app generated capability types. Every alias below degrades to
 * `string`/`unknown` when it is `false`, so the capability APIs stay usable
 * before the first `pracht typegen` run — the same shape as `ApiPath` and
 * `RouteId`.
 */
export type HasRegisteredCapabilities = keyof RegisteredCapabilityMap extends never ? false : true;

export type RegisteredCapabilityName = Extract<keyof RegisteredCapabilityMap, string>;

/**
 * Every registered capability name, including private ones: direct server
 * invocation reaches capabilities that are never exposed over the network.
 * Falls back to `string` before typegen has run.
 */
export type CapabilityName = HasRegisteredCapabilities extends true
  ? RegisteredCapabilityName
  : string;

type ExposedHttpCapabilityName = {
  [TName in keyof RegisteredCapabilityMap]: RegisteredCapabilityMap[TName] extends {
    exposed: { http: true };
  }
    ? TName
    : never;
}[keyof RegisteredCapabilityMap] &
  string;

/**
 * Whether every generated entry carries the exposure metadata introduced with
 * the typed browser client. Checking for the field — rather than checking
 * whether any capability is exposed — distinguishes a legacy declaration from
 * a current app whose capabilities are all deliberately private.
 */
type HasCapabilityExposureMetadata = HasRegisteredCapabilities extends true
  ? RegisteredCapabilityMap[RegisteredCapabilityName] extends {
      exposed: { http: boolean };
    }
    ? true
    : false
  : false;

/**
 * Capability names reachable from the browser — those with `expose.http`.
 * `callCapability()`, the generated `capabilities` client, and
 * `<Form capability>` use this so a private capability is a compile error
 * rather than a runtime `unknown_capability` envelope.
 *
 * When no entry carries `exposed` the filter would yield `never` and lock every
 * browser call out with an error that never mentions the real cause. That is
 * what a `pracht-capabilities.d.ts` generated before `exposed` existed looks
 * like, and those files are committed. Fall back to every registered name
 * instead: exposure is then unchecked (as it was before), and the runtime still
 * answers a private call with `unknown_capability`. Re-running `pracht typegen`
 * restores the check.
 */
export type HttpCapabilityName = HasRegisteredCapabilities extends true
  ? HasCapabilityExposureMetadata extends true
    ? ExposedHttpCapabilityName
    : RegisteredCapabilityName
  : string;

/**
 * The registration entry for a name, or `never` when the name is unregistered
 * (which includes every name before typegen has run). Each alias below checks
 * for that case explicitly: indexing an empty map yields `never`, and `never`
 * satisfies every `extends` test, so an unguarded conditional would silently
 * resolve to `never` instead of the intended `unknown`.
 */
type RegisteredCapabilityEntry<TName extends string> = TName extends keyof RegisteredCapabilityMap
  ? RegisteredCapabilityMap[TName]
  : never;

export type CapabilityInputFor<TName extends string> = [RegisteredCapabilityEntry<TName>] extends [
  never,
]
  ? unknown
  : RegisteredCapabilityEntry<TName> extends { input: infer TInput }
    ? TInput
    : unknown;

export type CapabilityOutputFor<TName extends string> = [RegisteredCapabilityEntry<TName>] extends [
  never,
]
  ? unknown
  : RegisteredCapabilityEntry<TName> extends { output: infer TOutput }
    ? TOutput
    : unknown;

/** Declared effect class, or the full union when typegen has not run. */
export type CapabilityEffectFor<TName extends string> = [RegisteredCapabilityEntry<TName>] extends [
  never,
]
  ? CapabilityEffect
  : RegisteredCapabilityEntry<TName> extends { effect: infer TEffect }
    ? TEffect
    : CapabilityEffect;

/**
 * The effect a registration actually states, or `never` when it states none.
 *
 * The confirmation gate has to tell apart two cases `CapabilityEffectFor`
 * collapses into one. A `pracht-capabilities.d.ts` generated before `effect`
 * was emitted declares nothing, and must keep behaving as it did — demanding a
 * token on every call would break every upgrading app. A registration that
 * declares the *full union* does so because the build could not read a broken
 * capability's effect, and that one must fail closed.
 */
type DeclaredCapabilityEffect<TName extends string> =
  RegisteredCapabilityEntry<TName> extends { effect: infer TEffect } ? TEffect : never;

/**
 * Argument list for a browser capability call — `callCapability()` and the
 * generated `capabilities` client. A capability whose input schema requires
 * nothing is callable with no argument at all; every other capability must
 * pass one. `TOptions` stays generic so the virtual module can supply its own
 * option type without `@pracht/core` importing it.
 *
 * Server-side `invokeCapability()` does not use this: its request context is
 * always required, so it takes a plain `(name, input, ctx)` signature.
 */
export type CapabilityInputArgs<TName extends string, TOptions> = {} extends TOptions
  ? {} extends CapabilityInputFor<TName>
    ? [input?: CapabilityInputFor<TName>, options?: TOptions]
    : [input: CapabilityInputFor<TName>, options?: TOptions]
  : // Options carry a required member (a `destructive` capability's prepare
    // marker or confirmation token), so neither argument may be omitted — an
    // optional parameter cannot precede a required one.
    [input: CapabilityInputFor<TName>, options: TOptions];

/**
 * Browser call options, narrowed per capability: a `destructive` capability is
 * gated by the server-verified prepare/commit flow. Mark the first call with
 * `{ prepare: true }`; committing instead requires the confirmation token from
 * that call's `confirmation_required` envelope. See AGENT_TRUST.md.
 *
 * The gate closes whenever `destructive` is *possible*, not only when it is
 * certain: a name typed as a union (`"notes.search" | "notes.purge"`) and a
 * capability whose effect could not be read at build time both demand the
 * token. Erring toward requiring it costs a caller one argument; erring the
 * other way silently drops the only compile-time half of the confirmation
 * flow.
 */
export type CapabilityCallOptionsFor<
  TName extends string,
  TOptions extends { confirm?: string },
> = [Extract<DeclaredCapabilityEffect<TName>, "destructive">] extends [never]
  ? TOptions
  :
      | (Omit<TOptions, "confirm"> & { confirm?: never; prepare: true })
      | (TOptions & { confirm: string; prepare?: never });

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
