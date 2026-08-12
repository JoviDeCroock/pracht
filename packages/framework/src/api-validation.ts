import type { StandardSchemaV1 } from "@standard-schema/spec";

import type {
  ApiRouteArgs,
  HttpMethod,
  MaybePromise,
  RegisteredContext,
  RouteParams,
} from "./types.ts";
import {
  apiValidationErrorResponse,
  assertApiJsonValue,
  readApiRequestBody,
  runApiSchema,
  searchParamsToRecord,
} from "./api-request-validation.ts";
import type { ApiValidationIssue } from "./api-request-validation.ts";

export {
  apiValidationErrorResponse,
  formDataToRecord,
  isApiValidationErrorBody,
  searchParamsToRecord,
  validateStandardSchema,
} from "./api-request-validation.ts";
export type {
  ApiValidationErrorBody,
  ApiValidationIssue,
  ApiValidationPathSegment,
  ApiValidationSource,
} from "./api-request-validation.ts";

export interface ApiRouteSchemas {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}

/** Values that can cross the JSON response boundary without changing type. */
export type ApiJsonPrimitive = string | number | boolean | null;
export type ApiJsonValue =
  | ApiJsonPrimitive
  | { readonly [key: string]: ApiJsonValue }
  | readonly ApiJsonValue[];

type JsonCompatible<T> = T extends ApiJsonPrimitive
  ? T
  : T extends bigint | symbol | undefined | ((...args: never[]) => unknown)
    ? never
    : T extends readonly unknown[]
      ? { [TKey in keyof T]: JsonCompatible<T[TKey]> }
      : T extends object
        ? { [TKey in keyof T]: JsonCompatible<T[TKey]> }
        : never;

type NonResponseResult<TResult> = Exclude<Awaited<TResult>, Response>;

/**
 * `Response` subtype produced by `json()`. Carries the payload type on a
 * type-only `"~payload"` marker (it never exists at runtime) so
 * `ApiHandlerOutput` can surface the payload to `apiFetch()` callers even
 * though the handler returns a `Response`.
 */
export interface TypedJsonResponse<TPayload> extends Response {
  readonly "~payload": TPayload;
}

type JsonValueConstraint<TValue> = [TValue] extends [JsonCompatible<TValue>]
  ? unknown
  : { readonly "json() values must be JSON-safe": never };

/**
 * `Response.json()` with the payload type preserved for `apiFetch()` callers.
 * Use it when a handler needs a non-200 status or custom headers without
 * collapsing the client-side response type to `unknown`:
 *
 * ```ts
 * export const POST = defineApi({
 *   body: itemSchema,
 *   handler: ({ body }) => json({ created: body.name }, { status: 201 }),
 * });
 * ```
 */
export function json<TValue>(
  value: TValue & JsonValueConstraint<NoInfer<TValue>>,
  init?: ResponseInit,
): TypedJsonResponse<TValue> {
  assertApiJsonValue(value);
  return Response.json(value, init) as TypedJsonResponse<TValue>;
}

type ApiHandlerResultConstraint<TResult> = [NonResponseResult<TResult>] extends [never]
  ? unknown
  : [NonResponseResult<TResult>] extends [JsonCompatible<NonResponseResult<TResult>>]
    ? unknown
    : {
        readonly "Handler return values must be JSON-safe or Response objects": never;
      };

type InferSchemaOutput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : undefined;

type InferSchemaInput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<TSchema>
  : unknown;

/**
 * Handler args for `defineApi()`. Extends the regular API route args with the
 * validated `body` and `query` values; `params` stays the raw string record
 * unless a `params` schema replaces it with the schema's output.
 */
export type ValidatedApiArgs<
  TBody = undefined,
  TQuery = undefined,
  TParams = RouteParams,
  TContext = RegisteredContext,
> = Omit<ApiRouteArgs<TContext>, "params"> & {
  body: TBody;
  query: TQuery;
  params: TParams;
};

type PlainResponseResult<TResult> =
  TResult extends TypedJsonResponse<any> ? never : Extract<TResult, Response>;

type TypedJsonPayload<TResult> =
  TResult extends TypedJsonResponse<infer TPayload> ? TPayload : never;

/**
 * JSON output type of a handler. `json()` responses carry their payload type;
 * any other `Response` branch keeps an `unknown` output because the payload
 * type cannot be recovered from the response status, headers, or body.
 */
type ApiHandlerOutput<TResult> = [PlainResponseResult<TResult>] extends [never]
  ? Exclude<TResult, Response> | TypedJsonPayload<TResult>
  : unknown;

/**
 * The callable produced by `defineApi()`. Compatible with the plain
 * `ApiRouteHandler` dispatch (`module[method](args)`), and carries the
 * request/response types on a type-only `~types` marker so
 * `ApiRouteMethodMap` (used by `pracht typegen`) can extract them.
 * The marker never exists at runtime.
 */
export interface ValidatedApiHandler<
  TBody = unknown,
  TQuery = unknown,
  TOutput = unknown,
  TParams = unknown,
> {
  // Callable with any context so the runtime dispatch, adapters, and tests
  // can invoke it directly; the inner handler sees the registered context.
  (args: ApiRouteArgs<any>): Promise<Response>;
  readonly schemas: ApiRouteSchemas;
  readonly "~types": { body: TBody; query: TQuery; output: TOutput; params: TParams };
}

export interface DefineApiConfig<
  TBodySchema extends StandardSchemaV1 | undefined,
  TQuerySchema extends StandardSchemaV1 | undefined,
  TParamsSchema extends StandardSchemaV1 | undefined,
  TResult,
  TContext,
> {
  /** Standard Schema for the request body (JSON or form submissions). */
  body?: TBodySchema;
  /** Standard Schema for the query string (values are strings or string arrays). */
  query?: TQuerySchema;
  /** Standard Schema for the route params (values are strings). */
  params?: TParamsSchema;
  handler: (
    args: ValidatedApiArgs<
      InferSchemaOutput<TBodySchema>,
      InferSchemaOutput<TQuerySchema>,
      TParamsSchema extends StandardSchemaV1
        ? StandardSchemaV1.InferOutput<TParamsSchema>
        : RouteParams,
      TContext
    >,
  ) => MaybePromise<TResult>;
}

type DefineApiHandler<
  TBodySchema extends StandardSchemaV1 | undefined,
  TQuerySchema extends StandardSchemaV1 | undefined,
  TParamsSchema extends StandardSchemaV1 | undefined,
  TContext,
  TResult = unknown,
> = DefineApiConfig<TBodySchema, TQuerySchema, TParamsSchema, TResult, TContext>["handler"];

/**
 * Define a validated API route handler.
 *
 * ```ts
 * // src/api/items.ts
 * import { defineApi } from "@pracht/core";
 * import * as z from "zod";
 *
 * export const POST = defineApi({
 *   body: z.object({ name: z.string() }),
 *   handler: ({ body }) => ({ created: body.name }),
 * });
 * ```
 *
 * The wrapper validates `body`, `query`, and `params` with any
 * [Standard Schema](https://standardschema.dev) validator before the handler
 * runs, and answers invalid requests with a 422 JSON body
 * (`{ error: "validation", issues }`). Handlers may return a `Response` for
 * full control, or a JSON-safe value whose type survives `Response.json()`.
 */
export function defineApi<
  THandler extends DefineApiHandler<TBodySchema, TQuerySchema, TParamsSchema, TContext, any>,
  TBodySchema extends StandardSchemaV1 | undefined = undefined,
  TQuerySchema extends StandardSchemaV1 | undefined = undefined,
  TParamsSchema extends StandardSchemaV1 | undefined = undefined,
  TContext = RegisteredContext,
>(
  config: Omit<
    DefineApiConfig<TBodySchema, TQuerySchema, TParamsSchema, never, TContext>,
    "handler"
  > & {
    handler: THandler & ApiHandlerResultConstraint<NoInfer<ReturnType<THandler>>>;
  },
): ValidatedApiHandler<
  InferSchemaInput<TBodySchema>,
  InferSchemaInput<TQuerySchema>,
  ApiHandlerOutput<Awaited<ReturnType<THandler>>>,
  InferSchemaInput<TParamsSchema>
> {
  const handler = async (args: ApiRouteArgs<TContext>): Promise<Response> => {
    const issues: ApiValidationIssue[] = [];

    let query: unknown;
    if (config.query) {
      query = await runApiSchema(
        config.query,
        searchParamsToRecord(args.url.searchParams),
        "query",
        issues,
      );
    }

    let params: unknown = args.params;
    if (config.params) {
      params = await runApiSchema(config.params, args.params, "params", issues);
    }

    let body: unknown;
    if (config.body) {
      const parsed = await readApiRequestBody(args.request);
      if (!parsed.ok) {
        return apiValidationErrorResponse([parsed.issue], { status: 400 });
      }
      body = await runApiSchema(config.body, parsed.value, "body", issues);
    }

    if (issues.length > 0) {
      return apiValidationErrorResponse(issues);
    }

    const result = await config.handler({
      ...args,
      body,
      query,
      params,
    } as never);

    if (result instanceof Response) {
      return result;
    }

    assertApiJsonValue(result);
    return Response.json(result);
  };

  return Object.assign(handler, {
    schemas: {
      body: config.body,
      query: config.query,
      params: config.params,
    },
  }) as never;
}

/**
 * Extract `{ body, query, output, params }` from one exported handler. `defineApi()`
 * handlers carry precise types; plain handlers fall back to `unknown`.
 */
export type ApiHandlerTypes<THandler> = THandler extends {
  readonly "~types": infer TTypes;
}
  ? TTypes
  : THandler extends (...args: never[]) => infer TResult
    ? { body: unknown; query: unknown; output: ApiHandlerOutput<Awaited<TResult>>; params: unknown }
    : never;

/**
 * Map an API route module's exported HTTP method handlers to their
 * request/response types. `pracht typegen` registers
 * `ApiRouteMethodMap<typeof import("./api/...")>` per route on
 * `Register["apiRoutes"]`, which `apiFetch()` reads for end-to-end types.
 */
export type ApiRouteMethodMap<TModule> = {
  [TMethod in (HttpMethod | "default") & keyof TModule]: ApiHandlerTypes<TModule[TMethod]>;
};
