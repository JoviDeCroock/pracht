import type { ComponentChildren, FunctionComponent } from "preact";

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

type RegisteredContext = Register extends { context: infer T } ? T : unknown;

export type RenderMode = "spa" | "ssr" | "ssg" | "isg";

export type RouteParams = Record<string, string>;

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

export type RouteRevalidate = TimeRevalidatePolicy;

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

export interface RouteMeta {
  id?: string;
  shell?: string;
  render?: RenderMode;
  middleware?: string[];
  revalidate?: RouteRevalidate;
  prefetch?: PrefetchStrategy;
}

export interface GroupMeta {
  shell?: string;
  render?: RenderMode;
  middleware?: string[];
  pathPrefix?: string;
}

export interface ApiConfig {
  middleware?: string[];
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

export interface PrachtAppConfig {
  shells?: Record<string, ModuleRef>;
  middleware?: Record<string, ModuleRef>;
  api?: ApiConfig;
  routes: RouteTreeNode[];
}

export interface PrachtApp {
  shells: Record<string, string>;
  middleware: Record<string, string>;
  api: ApiConfig;
  routes: RouteTreeNode[];
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
  name: "*";
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

export interface HeadMetadata {
  title?: string;
  lang?: string;
  meta?: Array<Record<string, string>>;
  link?: Array<Record<string, string>>;
}

export type MaybePromise<T> = T | Promise<T>;

export type LoaderLike = ((args: LoaderArgs<any>) => unknown) | undefined;

export type LoaderData<TLoader extends LoaderLike> = TLoader extends (
  ...args: any[]
) => infer TResult
  ? Awaited<TResult>
  : never;

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
  error: Error;
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
  head?: (args: BaseRouteArgs<TContext>) => MaybePromise<HeadMetadata>;
  headers?: (args: BaseRouteArgs<TContext>) => MaybePromise<HeadersInit>;
}

export type MiddlewareResult<TContext = any> =
  | void
  | Response
  | { redirect: string }
  | { context: Partial<TContext> };

export type MiddlewareFn<TContext = any> = (
  args: MiddlewareArgs<TContext>,
) => MaybePromise<MiddlewareResult<TContext>>;

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
}

export class PrachtHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PrachtHttpError";
    this.status = status;
  }
}
