import type { StandardSchemaV1 } from "@standard-schema/spec";

import type {
  ApiRouteArgs,
  HttpMethod,
  MaybePromise,
  RegisteredContext,
  RouteParams,
} from "./types.ts";

export interface ApiRouteSchemas {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}

export type ApiJsonPrimitive = string | number | boolean | null;
export type ApiJsonValue =
  | ApiJsonPrimitive
  | { readonly [key: string]: ApiJsonValue }
  | readonly ApiJsonValue[];

export type JsonCompatible<T> = T extends ApiJsonPrimitive
  ? T
  : T extends bigint | symbol | undefined | ((...args: never[]) => unknown)
    ? never
    : T extends readonly unknown[]
      ? { [TKey in keyof T]: JsonCompatible<T[TKey]> }
      : T extends object
        ? { [TKey in keyof T]: JsonCompatible<T[TKey]> }
        : never;

export interface TypedJsonResponse<TPayload> extends Response {
  readonly "~payload": TPayload;
}

export type JsonValueConstraint<TValue> = [TValue] extends [JsonCompatible<TValue>]
  ? unknown
  : { readonly "json() values must be JSON-safe": never };

type NonResponseResult<TResult> = Exclude<Awaited<TResult>, Response>;
export type ApiHandlerResultConstraint<TResult> = [NonResponseResult<TResult>] extends [never]
  ? unknown
  : [NonResponseResult<TResult>] extends [JsonCompatible<NonResponseResult<TResult>>]
    ? unknown
    : { readonly "Handler return values must be JSON-safe or Response objects": never };

export type InferSchemaOutput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : undefined;
export type InferSchemaInput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<TSchema>
  : unknown;

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
export type ApiHandlerOutput<TResult> = [PlainResponseResult<TResult>] extends [never]
  ? Exclude<TResult, Response> | TypedJsonPayload<TResult>
  : unknown;

export interface ValidatedApiHandler<
  TBody = unknown,
  TQuery = unknown,
  TOutput = unknown,
  TParams = unknown,
> {
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
  body?: TBodySchema;
  query?: TQuerySchema;
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

export type DefineApiHandler<
  TBodySchema extends StandardSchemaV1 | undefined,
  TQuerySchema extends StandardSchemaV1 | undefined,
  TParamsSchema extends StandardSchemaV1 | undefined,
  TContext,
  TResult = unknown,
> = DefineApiConfig<TBodySchema, TQuerySchema, TParamsSchema, TResult, TContext>["handler"];

export type ApiHandlerTypes<THandler> = THandler extends {
  readonly "~types": infer TTypes;
}
  ? TTypes
  : THandler extends (...args: never[]) => infer TResult
    ? { body: unknown; query: unknown; output: ApiHandlerOutput<Awaited<TResult>>; params: unknown }
    : never;

export type ApiRouteMethodMap<TModule> = {
  [TMethod in (HttpMethod | "default") & keyof TModule]: ApiHandlerTypes<TModule[TMethod]>;
};
