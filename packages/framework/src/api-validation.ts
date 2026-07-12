import type { StandardSchemaV1 } from "@standard-schema/spec";

import type {
  ApiRouteArgs,
  HttpMethod,
  MaybePromise,
  RegisteredContext,
  RouteParams,
} from "./types.ts";

/** Which part of the request a validation issue belongs to. */
export type ApiValidationSource = "body" | "query" | "params";
export type ApiValidationPathSegment = string | number;

/**
 * One normalized validation issue, serialized into the 422 response body and
 * surfaced to `apiFetch()` / `<Form onValidationIssues>` on the client.
 */
export interface ApiValidationIssue {
  in: ApiValidationSource;
  message: string;
  path?: ApiValidationPathSegment[];
}

/** JSON body of a validation failure response (HTTP 400/422). */
export interface ApiValidationErrorBody {
  error: "validation";
  issues: ApiValidationIssue[];
}

export function isApiValidationErrorBody(value: unknown): value is ApiValidationErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "validation" &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    (value as { issues: unknown[] }).issues.every(isApiValidationIssue)
  );
}

function isApiValidationIssue(value: unknown): value is ApiValidationIssue {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const issue = value as { in?: unknown; message?: unknown; path?: unknown };
  return (
    (issue.in === "body" || issue.in === "query" || issue.in === "params") &&
    typeof issue.message === "string" &&
    (issue.path === undefined ||
      (Array.isArray(issue.path) &&
        issue.path.every(
          (segment) =>
            typeof segment === "string" ||
            (typeof segment === "number" && Number.isFinite(segment)),
        )))
  );
}

/** Build the standardized validation failure response. */
export function apiValidationErrorResponse(
  issues: ApiValidationIssue[],
  init?: { status?: number },
): Response {
  const body: ApiValidationErrorBody = {
    error: "validation",
    issues: issues.map((issue) => ({
      ...issue,
      path: issue.path?.map(normalizeValidationPathSegment),
    })),
  };
  return Response.json(body, { status: init?.status ?? 422 });
}

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
      query = await runSchema(
        config.query,
        searchParamsToRecord(args.url.searchParams),
        "query",
        issues,
      );
    }

    let params: unknown = args.params;
    if (config.params) {
      params = await runSchema(config.params, args.params, "params", issues);
    }

    let body: unknown;
    if (config.body) {
      const parsed = await readRequestBody(args.request);
      if (!parsed.ok) {
        return apiValidationErrorResponse([parsed.issue], { status: 400 });
      }
      body = await runSchema(config.body, parsed.value, "body", issues);
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

function assertApiJsonValue(
  value: unknown,
  path = "$",
  ancestors: Set<object> = new Set(),
): asserts value is ApiJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw new TypeError(`defineApi() handler returned a non-finite number at ${path}.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`defineApi() handler returned a non-JSON value at ${path}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`defineApi() handler returned a circular value at ${path}.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`defineApi() handler returned a non-plain object at ${path}.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`defineApi() handler returned symbol-keyed data at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError(`defineApi() handler returned extra array data at ${path}.${key}.`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`defineApi() handler returned a sparse array at ${path}[${index}].`);
        }
        assertApiJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      assertApiJsonValue(entry, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Run a Standard Schema against a value and normalize the outcome: either the
 * validated value, or issues tagged with the request part they belong to.
 */
export async function validateStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
  source: ApiValidationSource,
): Promise<{ issues: null; value: unknown } | { issues: ApiValidationIssue[]; value?: never }> {
  let result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    result = await result;
  }

  if (result.issues) {
    return {
      issues: result.issues.map((issue) => ({
        in: source,
        message: issue.message,
        path: issue.path?.map((segment) =>
          normalizeValidationPathSegment(
            typeof segment === "object" && segment !== null ? segment.key : segment,
          ),
        ),
      })),
    };
  }

  return { issues: null, value: result.value };
}

function normalizeValidationPathSegment(segment: PropertyKey): ApiValidationPathSegment {
  return typeof segment === "symbol" || (typeof segment === "number" && !Number.isFinite(segment))
    ? String(segment)
    : segment;
}

async function runSchema(
  schema: StandardSchemaV1,
  value: unknown,
  source: ApiValidationSource,
  issues: ApiValidationIssue[],
): Promise<unknown> {
  const result = await validateStandardSchema(schema, value, source);
  if (result.issues) {
    issues.push(...result.issues);
    return undefined;
  }
  return result.value;
}

/**
 * Query values presented to the `query` schema: one string per key, or an
 * array of strings when the key repeats (`?tag=a&tag=b`).
 */
export function searchParamsToRecord(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const record = Object.create(null) as Record<string, string | string[]>;
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    record[key] = values.length === 1 ? values[0] : values;
  }
  return record;
}

/**
 * Form values presented to a schema: one entry per field, or an array when
 * the field repeats (multi-selects, checkbox groups). File fields stay `File`.
 */
export function formDataToRecord(
  formData: FormData,
): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const record = Object.create(null) as Record<string, FormDataEntryValue | FormDataEntryValue[]>;
  for (const key of new Set(formData.keys())) {
    const values = formData.getAll(key);
    record[key] = values.length === 1 ? values[0] : values;
  }
  return record;
}

type ParsedBody = { ok: true; value: unknown } | { ok: false; issue: ApiValidationIssue };

async function readRequestBody(request: Request): Promise<ParsedBody> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, value: undefined };
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      return { ok: true, value: formDataToRecord(await request.formData()) };
    } catch {
      return {
        ok: false,
        issue: { in: "body", message: "Malformed form body" },
      };
    }
  }

  const text = await request.text();
  if (text === "") {
    return { ok: true, value: undefined };
  }

  // JSON is the default body encoding; anything else must say so via
  // Content-Type and reaches the schema as the raw text.
  if (contentType === "" || contentType.includes("json")) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return {
        ok: false,
        issue: { in: "body", message: "Malformed JSON body" },
      };
    }
  }

  return { ok: true, value: text };
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
