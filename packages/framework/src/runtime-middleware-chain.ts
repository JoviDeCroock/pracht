import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  BaseRouteArgs,
  MiddlewareArgs,
  MiddlewareModule,
  ModuleRegistry,
  ResolvedApiRoute,
} from "./types.ts";

export interface RunMiddlewareChainOptions<TContext> {
  context: TContext;
  middlewareFiles: string[];
  params: Record<string, string>;
  registry: ModuleRegistry;
  request: Request;
  route: BaseRouteArgs<TContext>["route"] | ResolvedApiRoute;
  signal: AbortSignal;
  url: URL;
  terminal: () => Promise<Response>;
}

/**
 * Run middleware wrap-around-style. Imports start concurrently, while
 * execution remains sequential because context mutation and order are part of
 * the public contract. Each middleware may call `next()` at most once.
 */
export async function runMiddlewareChain<TContext>(
  options: RunMiddlewareChainOptions<TContext>,
): Promise<Response> {
  const { middlewareFiles, terminal } = options;
  if (middlewareFiles.length === 0) return terminal();

  const modulePromises = middlewareFiles.map((mwFile) =>
    resolveRegistryModule<MiddlewareModule>(options.registry.middlewareModules, mwFile),
  );
  // A short circuit may leave later imports unobserved; attach handlers so a
  // rejected speculative import cannot become an unhandled rejection.
  for (const promise of modulePromises) promise.catch(() => {});

  const dispatch = async (index: number): Promise<Response> => {
    if (index >= middlewareFiles.length) return terminal();

    const middlewareFile = middlewareFiles[index];
    const middlewareModule = await modulePromises[index];
    if (typeof middlewareModule?.middleware !== "function") {
      const message =
        `Middleware "${middlewareFile}" does not export a \`middleware\` function. ` +
        "Middleware modules must `export const middleware: MiddlewareFn = (args, next) => …` " +
        "(a default export is not used).";
      warnMissingMiddlewareExport(middlewareFile, message);
      throw new Error(message);
    }

    let calledNext = false;
    const next = (): Promise<Response> => {
      if (calledNext) {
        throw new Error(`Middleware "${middlewareFile}" called next() multiple times`);
      }
      calledNext = true;
      return dispatch(index + 1);
    };

    const args: MiddlewareArgs<TContext> = {
      request: options.request,
      params: options.params,
      context: options.context,
      signal: options.signal,
      url: options.url,
      route: options.route as BaseRouteArgs<TContext>["route"],
    };

    const response = await middlewareModule.middleware(args, next);
    if (!(response instanceof Response)) {
      throw new Error(
        `Middleware "${middlewareFile}" did not return a Response. ` +
          "Middleware must return the result of next() or a short-circuit Response.",
      );
    }
    return response;
  };

  return dispatch(0);
}

const warnedMissingMiddlewareExports = new Set<string>();

/** The failure repeats on every matching request, so log its cause once. */
function warnMissingMiddlewareExport(file: string, message: string): void {
  if (warnedMissingMiddlewareExports.has(file)) return;
  warnedMissingMiddlewareExports.add(file);
  console.error(`[pracht] ${message} Requests to routes using it fail closed.`);
}
