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

/**
 * One normalized validation issue, serialized into the 422 response body and
 * surfaced to `apiFetch()` / `<Form onValidationIssues>` on the client.
 */
export interface ApiValidationIssue {
  in: ApiValidationSource;
  message: string;
  path?: PropertyKey[];
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
    Array.isArray((value as { issues?: unknown }).issues)
  );
}

/** Build the standardized validation failure response. */
export function apiValidationErrorResponse(
  issues: ApiValidationIssue[],
  init?: { status?: number },
): Response {
  const body: ApiValidationErrorBody = { error: "validation", issues };
  return Response.json(body, { status: init?.status ?? 422 });
}

export interface ApiRouteSchemas {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}

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

/**
 * JSON output type of a handler: whatever it returns besides `Response`.
 * Handlers that only ever return `Response` keep an `unknown` output — the
 * payload type cannot be recovered from a `Response`.
 */
type ApiHandlerOutput<TResult> = [Exclude<TResult, Response>] extends [never]
  ? unknown
  : Exclude<TResult, Response>;

/**
 * The callable produced by `defineApi()`. Compatible with the plain
 * `ApiRouteHandler` dispatch (`module[method](args)`), and carries the
 * request/response types on a type-only `~types` marker so
 * `ApiRouteMethodMap` (used by `pracht typegen`) can extract them.
 * The marker never exists at runtime.
 */
export interface ValidatedApiHandler<TBody = unknown, TQuery = unknown, TOutput = unknown> {
  // Callable with any context so the runtime dispatch, adapters, and tests
  // can invoke it directly; the inner handler sees the registered context.
  (args: ApiRouteArgs<any>): Promise<Response>;
  readonly schemas: ApiRouteSchemas;
  readonly "~types": { body: TBody; query: TQuery; output: TOutput };
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
 * full control, or any JSON-serializable value to send as `Response.json()`.
 */
export function defineApi<
  TResult,
  TBodySchema extends StandardSchemaV1 | undefined = undefined,
  TQuerySchema extends StandardSchemaV1 | undefined = undefined,
  TParamsSchema extends StandardSchemaV1 | undefined = undefined,
  TContext = RegisteredContext,
>(
  config: DefineApiConfig<TBodySchema, TQuerySchema, TParamsSchema, TResult, TContext>,
): ValidatedApiHandler<
  InferSchemaInput<TBodySchema>,
  InferSchemaInput<TQuerySchema>,
  ApiHandlerOutput<Awaited<TResult>>
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

    return result instanceof Response ? result : Response.json(result);
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
          typeof segment === "object" && segment !== null ? segment.key : segment,
        ),
      })),
    };
  }

  return { issues: null, value: result.value };
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
  const record: Record<string, string | string[]> = {};
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
  const record: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
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

  const contentType = request.headers.get("content-type") ?? "";

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
 * Extract `{ body, query, output }` from one exported handler. `defineApi()`
 * handlers carry precise types; plain handlers fall back to `unknown`.
 */
export type ApiHandlerTypes<THandler> = THandler extends {
  readonly "~types": infer TTypes;
}
  ? TTypes
  : THandler extends (...args: never[]) => infer TResult
    ? { body: unknown; query: unknown; output: ApiHandlerOutput<Awaited<TResult>> }
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
