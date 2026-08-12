import type { MiddlewareArgs, MiddlewareFn, RegisteredContext } from "@pracht/core";

/**
 * Run one middleware or a chain of middleware exactly the way the runtime
 * does: each middleware receives `next` and may call it at most once; calling
 * `next()` invokes the rest of the chain (then `finalHandler`); returning
 * without calling `next()` short-circuits with that `Response`.
 *
 * ```ts
 * const args = createMiddlewareArgs({ url: "/dashboard" });
 * const response = await runMiddleware([logging, auth], args);
 * expect(readRedirect(response).location).toBe("/login");
 * ```
 *
 * `finalHandler` stands in for the loader/handler at the end of the chain and
 * defaults to an empty 200 `Response`. Middleware runs sequentially, so
 * `args.context` mutations made by one middleware are visible to the next —
 * the same ordering contract the server applies.
 *
 * A **thrown** `Response` (e.g. `throw redirect("/login")` from a shared
 * `requireUser()` helper) resolves as the chain's response, exactly like the
 * runtime treats it: the throw unwinds past upstream middleware first, so
 * response decoration after `await next()` is skipped unless that middleware
 * catches. Thrown non-`Response` errors (including `notFound()`'s
 * `PrachtHttpError`) reject, so tests can assert on them directly.
 */
export async function runMiddleware<TContext = RegisteredContext>(
  middleware: MiddlewareFn<TContext> | readonly MiddlewareFn<TContext>[],
  args: MiddlewareArgs<TContext>,
  finalHandler?: () => Response | Promise<Response>,
): Promise<Response> {
  const chain = typeof middleware === "function" ? [middleware] : middleware;
  const terminal = finalHandler ?? (() => new Response(null, { status: 200 }));

  const dispatch = async (index: number): Promise<Response> => {
    if (index >= chain.length) {
      return terminal();
    }

    let calledNext = false;
    const next = (): Promise<Response> => {
      if (calledNext) {
        throw new Error(`Middleware at index ${index} called next() multiple times`);
      }
      calledNext = true;
      return dispatch(index + 1);
    };

    const response = await chain[index](args, next);
    if (!(response instanceof Response)) {
      throw new Error(
        `Middleware at index ${index} did not return a Response. ` +
          "Middleware must return the result of next() or a short-circuit Response.",
      );
    }
    return response;
  };

  try {
    return await dispatch(0);
  } catch (error: unknown) {
    // Same contract as the server: a thrown Response is the middleware (or
    // final handler) answering, not failing. The runtime catches it around
    // the whole chain, so upstream middleware never see it — mirrored here
    // by catching outside `dispatch` rather than per middleware.
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
}
