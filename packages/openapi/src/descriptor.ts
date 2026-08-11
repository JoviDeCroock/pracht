import type { ApiRouteHandler } from "@pracht/core";

import type { OpenApiOperationDescriptor } from "./types.ts";

export const OPENAPI_OPERATION = Symbol.for("@pracht/openapi/operation");

export type OpenApiDocumentedHandler<THandler extends ApiRouteHandler<any>> = THandler & {
  readonly [OPENAPI_OPERATION]: OpenApiOperationDescriptor;
};

/**
 * Attach OpenAPI-only metadata to a Pracht API handler without changing its
 * runtime behavior or its `apiFetch()` request/response inference.
 *
 * Pass the result of `defineApi()` to retain Pracht's validation and types:
 *
 * ```ts
 * export const POST = defineOpenApi(
 *   defineApi({ body: createItemSchema, handler: createItem }),
 *   { responses: { 201: { description: "Created", body: itemSchema } } },
 * );
 * ```
 */
export function defineOpenApi<THandler extends ApiRouteHandler<any>>(
  handler: THandler,
  descriptor: OpenApiOperationDescriptor,
): OpenApiDocumentedHandler<THandler> {
  assertDescriptor(descriptor);
  return Object.assign(handler, {
    [OPENAPI_OPERATION]: {
      ...descriptor,
      responses: { ...descriptor.responses },
    },
  });
}

export function getOpenApiDescriptor(value: unknown): OpenApiOperationDescriptor | undefined {
  if (typeof value !== "function") return undefined;
  return (value as { [OPENAPI_OPERATION]?: OpenApiOperationDescriptor })[OPENAPI_OPERATION];
}

function assertDescriptor(descriptor: OpenApiOperationDescriptor): void {
  const responses = Object.entries(descriptor.responses);
  if (responses.length === 0) {
    throw new TypeError("defineOpenApi() requires at least one response.");
  }

  for (const [status, response] of responses) {
    if (!/^(?:default|[1-5](?:\d{2}|XX))$/i.test(status)) {
      throw new TypeError(
        `defineOpenApi() response key ${JSON.stringify(status)} must be an HTTP status, range such as 2XX, or "default".`,
      );
    }
    if (!response || typeof response.description !== "string" || !response.description.trim()) {
      throw new TypeError(
        `defineOpenApi() response ${JSON.stringify(status)} requires a non-empty description.`,
      );
    }
    if (response.contentType !== undefined && !response.contentType.trim()) {
      throw new TypeError(
        `defineOpenApi() response ${JSON.stringify(status)} contentType must be non-empty.`,
      );
    }
  }
}
