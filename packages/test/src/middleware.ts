import type { MiddlewareArgs, MiddlewareFn, RegisteredContext } from "@pracht/core";

export interface RunMiddlewareOptions {
  /**
   * Page and API dispatch normalize a thrown `Response` outside the raw
   * middleware chain, which is the default here. Set this to `reject` only
   * when intentionally modelling a raw capability middleware chain; prefer
   * `createCapabilityTestHost()` when the complete capability envelope matters.
   */
  thrownResponse?: "reject" | "resolve";
}

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
 * A **thrown** `Response` resolves as the result by default, matching page and
 * API dispatch's outer normalization. Pass `{ thrownResponse: "reject" }` as
 * the fourth argument only when modelling the raw chain used by capability
 * dispatch, which maps that throw to `internal_error`. Thrown non-`Response`
 * errors always reject.
 */
export async function runMiddleware<TContext = RegisteredContext>(
  middleware: MiddlewareFn<TContext> | readonly MiddlewareFn<TContext>[],
  args: MiddlewareArgs<TContext>,
  finalHandler?: () => Response | Promise<Response>,
  options: RunMiddlewareOptions = {},
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
    // Page/API dispatch catches a thrown Response outside the entire chain,
    // after it has unwound past upstream middleware. Preserve that established
    // helper default; capability tests can opt into raw-chain rejection.
    if (error instanceof Response && options.thrownResponse !== "reject") {
      return error;
    }
    throw error;
  }
}
