import type { CloudflareContextArgs, CloudflareExecutionContext } from "./runtime.ts";

/**
 * The fetch function the generated `virtual:pracht/server` module registers:
 * the same handler the generated Worker entry exports, with the app's
 * context factory passed per call.
 */
type PrachtWorkerFetch = (
  request: Request,
  env: unknown,
  executionContext: CloudflareExecutionContext,
  createContext?: (args: CloudflareContextArgs<any>) => unknown,
) => Promise<Response>;

let registeredFetch: PrachtWorkerFetch | undefined;

/**
 * @internal Called by the generated server module once the app manifest is
 * resolved. Not part of the published API.
 */
export function registerPrachtWorker(fetch: PrachtWorkerFetch): void {
  registeredFetch = fetch;
}

export interface PrachtHandlerOptions<TEnv = unknown, TContext = unknown> {
  /**
   * Build the `context` loaders, middleware, API routes, and capabilities
   * receive. Defaults to `{ env, executionContext }`.
   */
  createContext?: (args: CloudflareContextArgs<TEnv>) => TContext | Promise<TContext>;
}

export interface PrachtHandler<TEnv = unknown> {
  /** Serve a request through pracht: assets, ISG, pages, API routes, and capabilities. */
  fetch(
    request: Request,
    env: TEnv,
    executionContext: CloudflareExecutionContext,
  ): Promise<Response>;
}

/**
 * Create pracht's request handler inside a Worker entry module configured
 * with `cloudflareAdapter({ workerEntry })`.
 *
 * ```ts
 * import { createPrachtHandler } from "@pracht/adapter-cloudflare/worker";
 *
 * const pracht = createPrachtHandler();
 *
 * export default {
 *   fetch(request, env, ctx) {
 *     return pracht.fetch(request, env, ctx);
 *   },
 * };
 * ```
 */
export function createPrachtHandler<TEnv = unknown, TContext = unknown>(
  options: PrachtHandlerOptions<TEnv, TContext> = {},
): PrachtHandler<TEnv> {
  const createContext = options.createContext as
    | ((args: CloudflareContextArgs<any>) => unknown)
    | undefined;
  return {
    fetch(request, env, executionContext) {
      if (!registeredFetch) {
        throw new Error(
          "createPrachtHandler() has no pracht app to serve. Import it from the module " +
            "configured as cloudflareAdapter({ workerEntry }) and run the Worker built by " +
            "`pracht dev` or `pracht build`.",
        );
      }
      return registeredFetch(request, env, executionContext, createContext);
    },
  };
}
