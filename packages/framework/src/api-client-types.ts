import type { Register } from "./registration.ts";
import type { RouteParamInput, SearchParamsInput } from "./route-inputs.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

type EmptyRouteParams = Record<never, never>;
type IsEmptyRouteParams<TParams> = keyof TParams extends never ? true : false;

type RegisteredApiRouteMap = Register extends { apiRoutes: infer TApiRoutes }
  ? TApiRoutes extends Record<string, unknown>
    ? TApiRoutes
    : {}
  : {};

type HasRegisteredApiRoutes = keyof RegisteredApiRouteMap extends never ? false : true;

/**
 * API route path templates registered by `pracht typegen` (e.g.
 * `"/api/items/:id"`). Falls back to `string` when no api routes are
 * registered so `apiFetch()` stays usable without codegen.
 */
export type ApiPath = HasRegisteredApiRoutes extends true
  ? Extract<keyof RegisteredApiRouteMap, string>
  : string;

type ApiRouteEntryFor<TPath> = TPath extends keyof RegisteredApiRouteMap
  ? RegisteredApiRouteMap[TPath]
  : never;

type ApiMethodMapFor<TPath> =
  ApiRouteEntryFor<TPath> extends { methods: infer TMethods } ? TMethods : {};

/** HTTP methods handled by the registered route, including default fallbacks. */
export type ApiMethodsFor<TPath extends ApiPath> = HasRegisteredApiRoutes extends true
  ? "default" extends keyof ApiMethodMapFor<TPath>
    ? HttpMethod
    : Extract<keyof ApiMethodMapFor<TPath>, HttpMethod> extends never
      ? HttpMethod
      : Extract<keyof ApiMethodMapFor<TPath>, HttpMethod>
  : HttpMethod;

type ApiMethodTypesFor<
  TPath extends ApiPath,
  TMethod,
> = TMethod extends keyof ApiMethodMapFor<TPath>
  ? ApiMethodMapFor<TPath>[TMethod]
  : "default" extends keyof ApiMethodMapFor<TPath>
    ? ApiMethodMapFor<TPath>["default"]
    : { body: unknown; query: unknown; output: unknown; params: unknown };

export type ApiBodyFor<TPath extends ApiPath, TMethod extends HttpMethod> = TMethod extends
  | "GET"
  | "HEAD"
  ? undefined
  : ApiMethodTypesFor<TPath, TMethod> extends { body: infer TBody }
    ? TBody
    : unknown;

export type ApiQueryFor<TPath extends ApiPath, TMethod extends HttpMethod> =
  ApiMethodTypesFor<TPath, TMethod> extends { query: infer TQuery } ? TQuery : unknown;

export type ApiOutputFor<TPath extends ApiPath, TMethod extends HttpMethod> = TMethod extends "HEAD"
  ? undefined
  : ApiMethodTypesFor<TPath, TMethod> extends { output: infer TOutput }
    ? TOutput
    : unknown;

export type ApiParamsFor<TPath extends ApiPath> = HasRegisteredApiRoutes extends true
  ? ApiRouteEntryFor<TPath> extends { params: infer TParams }
    ? TParams extends Record<string, unknown>
      ? TParams
      : EmptyRouteParams
    : EmptyRouteParams
  : Record<string, RouteParamInput>;

type ApiParamsSchemaInputFor<TPath extends ApiPath, TMethod extends HttpMethod> =
  ApiMethodTypesFor<TPath, TMethod> extends { params: infer TParams } ? TParams : unknown;

type ApiFetchMethodField<TMethod> = TMethod extends "GET"
  ? { method?: "GET" }
  : { method: TMethod };

type ContainsFileValue<TValue> = [Extract<TValue, Blob>] extends [never]
  ? TValue extends readonly (infer TEntry)[]
    ? [Extract<TEntry, Blob>] extends [never]
      ? false
      : true
    : false
  : true;

type ApiBodyAcceptsFormData<TBody> =
  TBody extends Record<string, unknown>
    ? true extends {
        [TKey in keyof TBody]-?: ContainsFileValue<NonNullable<TBody[TKey]>>;
      }[keyof TBody]
      ? true
      : false
    : false;

/**
 * A `File`/`Blob`-bearing body schema targets multipart form submissions.
 * JSON-encoding such a body would silently drop the file (`File` serializes
 * to `{}`), so `FormData` is accepted as the wire format for those routes.
 */
type ApiFetchBodyInput<TBody> =
  true extends ApiBodyAcceptsFormData<NonNullable<TBody>> ? TBody | FormData : TBody;

type ApiFetchBodyField<TBody> = unknown extends TBody
  ? { body?: unknown }
  : undefined extends TBody
    ? { body?: ApiFetchBodyInput<TBody> }
    : { body: ApiFetchBodyInput<TBody> };

type QueryWireValue = string | readonly string[];

/**
 * Query values cross the wire as URL search params: the server always hands
 * the query schema a string per key (or a string array for repeated keys). A
 * schema input with no string representation — `z.number()`, `z.boolean()` —
 * would type-check here yet fail validation on every request, so those keys
 * become a compile-time error instead. Inputs that accept strings
 * (`z.coerce.number()`, `z.enum([...])`, unions with a string arm) pass
 * through unchanged.
 */
type ApiQueryWireCheck<TQuery> =
  TQuery extends Record<string, unknown>
    ? {
        [TKey in keyof TQuery]: unknown extends TQuery[TKey]
          ? TQuery[TKey]
          : [Extract<NonNullable<TQuery[TKey]>, QueryWireValue>] extends [never]
            ? {
                readonly "Query values arrive as strings; give this key a schema input that accepts them (e.g. z.coerce.number())": never;
              }
            : TQuery[TKey];
      }
    : TQuery;

type ApiFetchQueryField<TQuery> = unknown extends TQuery
  ? { query?: SearchParamsInput }
  : Record<never, never> extends TQuery
    ? { query?: ApiQueryWireCheck<TQuery> }
    : { query: ApiQueryWireCheck<TQuery> };

type ApiParamWireError = {
  readonly "Route params arrive as strings; give this key a schema input that accepts them (e.g. z.coerce.number())": never;
};

/**
 * Route params are interpolated from convenient primitive inputs, but the
 * server always hands their string representation to the params schema. Keep
 * the ergonomic call-site type while rejecting schema keys that cannot accept
 * that wire value. Opaque schema inputs (`unknown`) remain permissive.
 */
type ApiParamsWireCheck<TPathParams, TSchemaInput> = unknown extends TSchemaInput
  ? TPathParams
  : TSchemaInput extends Record<string, unknown>
    ? {
        [TKey in keyof TPathParams]: TKey extends keyof TSchemaInput
          ? unknown extends TSchemaInput[TKey]
            ? TPathParams[TKey]
            : [Extract<NonNullable<TSchemaInput[TKey]>, string>] extends [never]
              ? ApiParamWireError
              : TPathParams[TKey]
          : TPathParams[TKey];
      }
    : { [TKey in keyof TPathParams]: ApiParamWireError };

type ApiFetchParamsField<
  TPath extends ApiPath,
  TMethod extends HttpMethod,
> = HasRegisteredApiRoutes extends true
  ? IsEmptyRouteParams<ApiParamsFor<TPath>> extends true
    ? { params?: never }
    : {
        params: ApiParamsWireCheck<ApiParamsFor<TPath>, ApiParamsSchemaInputFor<TPath, TMethod>>;
      }
  : { params?: Record<string, RouteParamInput> };

export interface ApiFetchBaseOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Custom fetch implementation (tests, server-to-server calls). */
  fetch?: typeof globalThis.fetch;
  /** Prefix for the request URL, e.g. an absolute origin during SSR. */
  baseUrl?: string;
}

export type ApiFetchOptions<
  TPath extends ApiPath = ApiPath,
  TMethod extends ApiMethodsFor<TPath> = ApiMethodsFor<TPath>,
> =
  TMethod extends ApiMethodsFor<TPath>
    ? ApiFetchBaseOptions &
        ApiFetchMethodField<TMethod> &
        ApiFetchBodyField<ApiBodyFor<TPath, TMethod>> &
        ApiFetchQueryField<ApiQueryFor<TPath, TMethod>> &
        ApiFetchParamsField<TPath, TMethod>
    : never;

export type ApiFetchArgs<TPath extends ApiPath, TMethod extends ApiMethodsFor<TPath>> =
  Record<never, never> extends ApiFetchOptions<TPath, TMethod>
    ? [options?: ApiFetchOptions<TPath, TMethod>]
    : [options: ApiFetchOptions<TPath, TMethod>];

export type DefaultApiMethod<TPath extends ApiPath> =
  "GET" extends ApiMethodsFor<TPath> ? "GET" : ApiMethodsFor<TPath>;
