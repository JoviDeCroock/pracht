import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  apiValidationErrorResponse,
  assertApiJsonValue,
  readApiRequestBody,
  runApiSchema,
  searchParamsToRecord,
  type ApiValidationIssue,
} from "./api-request-validation.ts";
import type {
  ApiHandlerOutput,
  ApiHandlerResultConstraint,
  DefineApiConfig,
  DefineApiHandler,
  InferSchemaInput,
  ValidatedApiHandler,
} from "./api-validation-types.ts";
import type { ApiRouteArgs, RegisteredContext } from "./types.ts";

/** Define a Standard Schema-validated API route handler. */
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
    if (config.params) params = await runApiSchema(config.params, args.params, "params", issues);
    let body: unknown;
    if (config.body) {
      const parsed = await readApiRequestBody(args.request);
      if (!parsed.ok) return apiValidationErrorResponse([parsed.issue], { status: 400 });
      body = await runApiSchema(config.body, parsed.value, "body", issues);
    }
    if (issues.length > 0) return apiValidationErrorResponse(issues);

    const result = await config.handler({ ...args, body, query, params } as never);
    if (result instanceof Response) return result;
    assertApiJsonValue(result);
    return Response.json(result);
  };

  return Object.assign(handler, {
    schemas: { body: config.body, query: config.query, params: config.params },
  }) as never;
}
