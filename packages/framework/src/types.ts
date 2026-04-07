import type { ComponentChildren, FunctionComponent } from "preact";

export type RenderMode = "spa" | "ssr" | "ssg" | "isg";

export type RouteParams = Record<string, string>;

export interface TimeRevalidatePolicy {
  kind: "time";
  seconds: number;
}

export type RouteRevalidate = TimeRevalidatePolicy;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type ApiRouteHandler<TContext = unknown> = (
  args: BaseRouteArgs<TContext>,
) => MaybePromise<Response>;

export interface ApiRouteModule<TContext = unknown> {
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
  component: string | LazyImport;
  loader?: string;
  action?: string;
}

export interface RouteDefinition extends RouteMeta {
  kind: "route";
  path: string;
  file?: string;
  component?: LazyImport;
  loaderFile?: string;
  actionFile?: string;
}

export interface GroupDefinition {
  kind: "group";
  meta: GroupMeta;
  routes: RouteTreeNode[];
}

export type RouteTreeNode = RouteDefinition | GroupDefinition;

export interface ViactAppConfig {
  shells?: Record<string, string>;
  middleware?: Record<string, string>;
  api?: ApiConfig;
  routes: RouteTreeNode[];
}

export interface ViactApp {
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
  file?: string;
  component?: LazyImport;
  loaderFile?: string;
  actionFile?: string;
  shell?: string;
  shellFile?: string;
  middleware: string[];
  middlewareFiles: string[];
  segments: RouteSegment[];
}

export interface ResolvedViactApp extends Omit<ViactApp, "routes"> {
  routes: ResolvedRoute[];
  apiRoutes: ResolvedApiRoute[];
}

export interface RouteMatch {
  route: ResolvedRoute;
  params: RouteParams;
  pathname: string;
}

export interface BaseRouteArgs<TContext = unknown> {
  request: Request;
  params: RouteParams;
  context: TContext;
  signal: AbortSignal;
  url: URL;
  route: ResolvedRoute;
}

export interface LoaderArgs<TContext = unknown> extends BaseRouteArgs<TContext> {}

export interface ActionArgs<TContext = unknown> extends BaseRouteArgs<TContext> {}

export interface MiddlewareArgs<TContext = unknown> extends BaseRouteArgs<TContext> {}

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
  TContext = unknown,
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

export interface ActionEnvelope<TData = unknown> {
  ok?: boolean;
  data?: TData;
  revalidate?: string[];
  redirect?: string;
  headers?: HeadersInit;
}

export type ActionResult<TData = unknown> = TData | ActionEnvelope<TData>;

export type LoaderFn<TContext = unknown, TData = unknown> = (
  args: LoaderArgs<TContext>,
) => MaybePromise<TData>;

export type ActionFn<TContext = unknown, TData = unknown> = (
  args: ActionArgs<TContext>,
) => MaybePromise<ActionResult<TData>>;

export interface RouteModule<TContext = unknown, TLoader extends LoaderLike = undefined> {
  loader?: LoaderFn<TContext>;
  action?: ActionFn<TContext>;
  head?: (args: HeadArgs<TLoader, TContext>) => MaybePromise<HeadMetadata>;
  Component: FunctionComponent<RouteComponentProps<TLoader>>;
  ErrorBoundary?: FunctionComponent<ErrorBoundaryProps>;
  prerender?: () => MaybePromise<string[]>;
}

export interface ShellModule<TContext = unknown> {
  Shell: FunctionComponent<ShellProps>;
  head?: (args: BaseRouteArgs<TContext>) => MaybePromise<HeadMetadata>;
}

export type MiddlewareResult<TContext = unknown> =
  | void
  | Response
  | { redirect: string }
  | { context: Partial<TContext> };

export type MiddlewareFn<TContext = unknown> = (
  args: MiddlewareArgs<TContext>,
) => MaybePromise<MiddlewareResult<TContext>>;

export interface MiddlewareModule<TContext = unknown> {
  middleware: MiddlewareFn<TContext>;
}

export type LazyImport<TModule = unknown> = () => Promise<TModule>;

export type ModuleImporter<TModule = unknown> = LazyImport<TModule>;

export interface DataModule<TContext = unknown> {
  loader?: LoaderFn<TContext>;
  action?: ActionFn<TContext>;
}

export interface ModuleRegistry {
  routeModules?: Record<string, ModuleImporter<RouteModule>>;
  shellModules?: Record<string, ModuleImporter<ShellModule>>;
  middlewareModules?: Record<string, ModuleImporter<MiddlewareModule>>;
  apiModules?: Record<string, ModuleImporter<ApiRouteModule>>;
  dataModules?: Record<string, ModuleImporter<DataModule>>;
}

export class ViactHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ViactHttpError";
    this.status = status;
  }
}
