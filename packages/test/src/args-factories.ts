import type { RegisteredContext, ResolvedApiRoute, ResolvedRoute, RouteParams } from "@pracht/core";

import type {
  CreateApiArgsInput,
  CreateArgsInput,
  CreateLoaderArgsInput,
  CreateMiddlewareArgsInput,
  TestApiArgs,
  TestApiMiddlewareArgs,
  TestLoaderArgs,
  TestMiddlewareArgs,
} from "./args-types.ts";
import { createTestRequest } from "./request.ts";

interface BuiltBaseArgs<TContext> {
  request: Request;
  params: RouteParams;
  context: TContext;
  signal: AbortSignal;
  url: URL;
  controller: AbortController;
}

/**
 * Build a complete `LoaderArgs` for calling a route loader directly:
 *
 * ```ts
 * const args = createLoaderArgs({ url: "/blog/hello", params: { slug: "hello" } });
 * const data = await loader(args);
 * ```
 *
 * Every field has a sensible default; override only what the loader reads.
 * The returned object also carries `controller` — the `AbortController`
 * behind `args.signal` — for cancellation tests.
 */
export function createLoaderArgs<TContext = RegisteredContext>(
  input: CreateLoaderArgsInput<TContext> = {},
): TestLoaderArgs<TContext> {
  const base = buildBaseArgs(input);
  return {
    ...base,
    route: buildResolvedRoute(base.url, input.route),
  };
}

/**
 * Build a complete `MiddlewareArgs` — the same shape as `LoaderArgs` — for
 * calling middleware directly or through `runMiddleware()`.
 */
export function createMiddlewareArgs<TContext = RegisteredContext>(
  input: CreateMiddlewareArgsInput<TContext> = {},
): TestMiddlewareArgs<TContext> {
  return createLoaderArgs(input);
}

/**
 * Build middleware args for a chain attached through `defineApp({ api })`.
 * Unlike page middleware, the matched route has API metadata only — no
 * `middleware`, `middlewareFiles`, render mode, shell, or loader fields.
 */
export function createApiMiddlewareArgs<TContext = RegisteredContext>(
  input: CreateApiArgsInput<TContext> = {},
): TestApiMiddlewareArgs<TContext> {
  return createApiArgs(input);
}

/**
 * Build a complete `ApiRouteArgs` for calling an API route handler (plain or
 * `defineApi()`-wrapped) directly:
 *
 * ```ts
 * const response = await POST(createApiArgs({ url: "/api/items", body: { name: "x" } }));
 * ```
 */
export function createApiArgs<TContext = RegisteredContext>(
  input: CreateApiArgsInput<TContext> = {},
): TestApiArgs<TContext> {
  const base = buildBaseArgs(input);
  return {
    ...base,
    route: buildResolvedApiRoute(base.url, input.route),
  };
}

function buildBaseArgs<TContext>(input: CreateArgsInput<TContext>): BuiltBaseArgs<TContext> {
  const request = createTestRequest(input);
  const controller = new AbortController();
  return {
    request,
    params: input.params ?? {},
    context: (input.context ?? {}) as TContext,
    signal: input.signal ?? controller.signal,
    url: new URL(request.url),
    controller,
  };
}

function buildResolvedRoute(url: URL, overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    path: url.pathname,
    file: "test://route.tsx",
    middleware: [],
    middlewareFiles: [],
    segments: [],
    ...overrides,
  };
}

function buildResolvedApiRoute(
  url: URL,
  overrides: Partial<ResolvedApiRoute> = {},
): ResolvedApiRoute {
  return {
    path: url.pathname,
    file: "test://api-route.ts",
    segments: [],
    ...overrides,
  };
}
