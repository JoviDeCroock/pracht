import type { PrachtAgentsConfig } from "./agent-types.ts";
import type { RouteConstraint } from "./constraints.ts";
import type { RouteParams } from "./route-inputs.ts";
import type { GroupMeta, HydrationMode, RouteMeta } from "./route-policy-types.ts";

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
