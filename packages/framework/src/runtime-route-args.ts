/**
 * The route arguments a page route's middleware, loaders, and server islands
 * see, built in one place.
 *
 * Both the page pipeline (`renderPage`) and the server island endpoint run a
 * page route's middleware chain and loaders, and a server island loader must
 * get the same arguments from either. Every page-scoped argument is added
 * here, so a new field reaches both paths or neither.
 *
 * @internal Not part of the published API.
 */
import { parseRouteSearch } from "./api-validation.ts";
import type { RouteErrorContext, SerializedRouteError } from "./runtime-errors.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import { createRequestWaitUntil, type HandlePrachtRequestOptions } from "./runtime-request.ts";
import type { BaseRouteArgs, LoaderArgs, ModuleRegistry, RouteMatch } from "./types.ts";

export interface PageRouteArgsInit<TContext> {
  /** The page's request: its URL is the page URL. */
  request: Request;
  url: URL;
  context: TContext;
  signal: AbortSignal;
  /** Path `waitUntil` failures are reported under. */
  requestPath: string;
  /** Extra attribution for `waitUntil` failures (e.g. the server island). */
  errorContext?: Omit<RouteErrorContext, "phase">;
}

/**
 * Build the route args for one matched page route. `search` and `root` are
 * filled in later, after middleware: `applyRouteSearch()` sets
 * `search`, and each caller sets `root` from `resolveRequestRoot()`.
 */
export function createPageRouteArgs<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
  match: RouteMatch,
  init: PageRouteArgsInit<TContext>,
): LoaderArgs<TContext> {
  return {
    request: init.request,
    params: match.params,
    context: init.context,
    signal: init.signal,
    url: init.url,
    route: match.route,
    pathname: match.pathname,
    waitUntil: createRequestWaitUntil(options, init.requestPath, options.onRouteError, {
      loaderFile: match.route.loaderFile,
      middlewareFiles: [...(match.route.middlewareFiles ?? [])],
      routeFile: match.route.file,
      routeId: match.route.id,
      routePath: match.route.path,
      shellFile: match.route.shellFile,
      ...init.errorContext,
    }),
  };
}

/** Run the page route's middleware chain around `terminal`, from its route args. */
export function runPageMiddlewareChain<TContext>(
  routeArgs: BaseRouteArgs<TContext>,
  registry: ModuleRegistry,
  terminal: () => Promise<Response>,
  onMiddlewareError?: (error: unknown, file: string) => void,
): Promise<Response> {
  return runMiddlewareChain({
    context: routeArgs.context,
    middlewareFiles: routeArgs.route.middlewareFiles,
    params: routeArgs.params,
    pathname: routeArgs.pathname,
    registry,
    request: routeArgs.request,
    route: routeArgs.route,
    signal: routeArgs.signal,
    url: routeArgs.url,
    waitUntil: routeArgs.waitUntil,
    terminal,
    onMiddlewareError,
  });
}

/**
 * Validate the page URL's query with the route module's `search` export and
 * set the result as `search` on `routeArgs`. Returns the rejection, if any;
 * `routeArgs` is left untouched then.
 */
export async function applyRouteSearch<TContext>(
  routeArgs: BaseRouteArgs<TContext>,
  searchSchema: unknown,
): Promise<SerializedRouteError | undefined> {
  const search = await parseRouteSearch(searchSchema, routeArgs.url.href);
  if (search.error) return search.error;
  (routeArgs as LoaderArgs<TContext>).search = search.value;
  return undefined;
}
