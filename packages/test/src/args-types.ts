import type {
  ApiRouteArgs,
  LoaderArgs,
  MiddlewareArgs,
  RegisteredContext,
  ResolvedApiRoute,
  ResolvedRoute,
  RouteParams,
} from "@pracht/core";

import type { TestRequestInput } from "./request.ts";

/** Input shared by every args factory. */
export interface CreateArgsInput<TContext = RegisteredContext> extends TestRequestInput {
  /** Dynamic route params (e.g. `{ slug: "hello" }`). Default `{}`. */
  params?: RouteParams;
  /** Request context. A partial is accepted — provide what the code under test reads. */
  context?: Partial<TContext>;
  /** Override the abort signal. When omitted, `controller.signal` is used. */
  signal?: AbortSignal;
}

export interface CreateLoaderArgsInput<
  TContext = RegisteredContext,
> extends CreateArgsInput<TContext> {
  /** Override matched-route metadata; merged over sensible defaults. */
  route?: Partial<ResolvedRoute>;
}

export interface CreateMiddlewareArgsInput<
  TContext = RegisteredContext,
> extends CreateLoaderArgsInput<TContext> {}

export interface CreateApiArgsInput<
  TContext = RegisteredContext,
> extends CreateArgsInput<TContext> {
  /** Override matched API route metadata; merged over sensible defaults. */
  route?: Partial<ResolvedApiRoute>;
}

/**
 * The controller behind `args.signal`, so a test can abort mid-flight:
 * `args.controller.abort()`. When a custom `signal` is passed in, the
 * controller is still returned but no longer wired to `args.signal`.
 */
export interface TestAbortControls {
  controller: AbortController;
}

export type TestLoaderArgs<TContext = RegisteredContext> = LoaderArgs<TContext> & TestAbortControls;
export type TestMiddlewareArgs<TContext = RegisteredContext> = Omit<
  MiddlewareArgs<TContext>,
  "route"
> &
  TestAbortControls & { route: ResolvedRoute };
export type TestApiMiddlewareArgs<TContext = RegisteredContext> = Omit<
  MiddlewareArgs<TContext>,
  "route"
> &
  TestAbortControls & { route: ResolvedApiRoute };
export type TestApiArgs<TContext = RegisteredContext> = ApiRouteArgs<TContext> & TestAbortControls;
