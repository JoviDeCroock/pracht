/**
 * The wrap-around middleware chain runner shared by every dispatch path.
 * Moved here from `@pracht/core` so capability dispatch — including the
 * standalone host — and the framework's page/API pipelines execute the exact
 * same chain semantics; `@pracht/core` re-exports it.
 */

import { resolveRegistryModule } from "./registry.ts";
import type { CapabilityModuleRegistry, MiddlewareArgs, MiddlewareModule } from "./types.ts";

/**
 * Run the middleware chain wrap-around-style. Each middleware receives
 * `next` and may call it at most once. Calling `next()` invokes the rest
 * of the chain (downstream middleware then `terminal`) and resolves to
 * the final `Response`. A middleware that returns without calling `next()`
 * short-circuits with whatever Response it returned.
 *
 * Module imports are kicked off concurrently up front; execution stays
 * sequential because middleware may mutate `args.context` and ordering
 * is part of the public contract.
 */
export async function runMiddlewareChain<TContext>(options: {
  context: TContext;
  middlewareFiles: string[];
  params: Record<string, string>;
  pathname?: string;
  registry: CapabilityModuleRegistry;
  request: Request;
  route: unknown;
  signal: AbortSignal;
  url: URL;
  terminal: () => Promise<Response>;
}): Promise<Response> {
  const { middlewareFiles, terminal } = options;

  if (middlewareFiles.length === 0) {
    return terminal();
  }

  // Kick off module resolution for every middleware in parallel. Execution
  // below still runs sequentially — middleware may mutate context and the
  // ordering is part of the public contract — but the imports themselves
  // have no inter-dependency, so waiting for them one-by-one is pure
  // latency for no benefit. On cold starts where middleware ships as its
  // own chunks this can meaningfully reduce TTFB.
  const modulePromises = middlewareFiles.map((mwFile) =>
    resolveRegistryModule<MiddlewareModule>(options.registry.middlewareModules, mwFile),
  );
  // Suppress unhandled-rejection warnings for promises that may not be
  // awaited if an earlier middleware short-circuits without calling next().
  for (const p of modulePromises) {
    p.catch(() => {});
  }

  const dispatch = async (i: number): Promise<Response> => {
    if (i >= middlewareFiles.length) {
      return terminal();
    }
    const mwModule = await modulePromises[i];
    // A registered middleware module that exports nothing usable used to be
    // skipped silently. That fails *open*: a renamed export or a `default`
    // export leaves an auth gate wired in the manifest but absent at runtime,
    // and every static check still passes. Refuse to serve instead.
    if (typeof mwModule?.middleware !== "function") {
      const message =
        `Middleware "${middlewareFiles[i]}" does not export a \`middleware\` function. ` +
        "Middleware modules must `export const middleware: MiddlewareFn = (args, next) => …` " +
        "(a default export is not used).";
      // Failing closed is right, but silently failing closed is an outage a
      // reviewer has to bisect: the likely trigger is a refactor renaming the
      // export, which takes down every route carrying this middleware at
      // deploy time. Sanitized 5xx responses say nothing, so log the cause
      // once per module — the same treatment capability-registry failures get.
      warnMissingMiddlewareExport(middlewareFiles[i], message);
      throw new Error(message);
    }

    let calledNext = false;
    const next = (): Promise<Response> => {
      if (calledNext) {
        throw new Error(`Middleware "${middlewareFiles[i]}" called next() multiple times`);
      }
      calledNext = true;
      return dispatch(i + 1);
    };

    const args: MiddlewareArgs<TContext> = {
      request: options.request,
      params: options.params,
      pathname: options.pathname,
      context: options.context,
      signal: options.signal,
      url: options.url,
      route: options.route,
    };

    const response = await mwModule.middleware(args, next);
    if (!(response instanceof Response)) {
      throw new Error(
        `Middleware "${middlewareFiles[i]}" did not return a Response. ` +
          "Middleware must return the result of next() or a short-circuit Response.",
      );
    }
    return response;
  };

  return dispatch(0);
}

const warnedMissingMiddlewareExports = new Set<string>();

/** The failure repeats on every matching request — log the cause once. */
function warnMissingMiddlewareExport(file: string, message: string): void {
  if (warnedMissingMiddlewareExports.has(file)) return;
  warnedMissingMiddlewareExports.add(file);
  console.error(`[pracht] ${message} Requests to routes using it fail closed.`);
}
