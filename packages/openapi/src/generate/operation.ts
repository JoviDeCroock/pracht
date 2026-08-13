import type { ApiRouteSchemas } from "@pracht/core";

import { getOpenApiDescriptor } from "../descriptor.ts";
import type {
  OpenApiOperationDescriptor,
  OpenApiOperationObject,
  OpenApiParameterObject,
  OpenApiResponseObject,
  OpenApiSchema,
} from "../types.ts";
import type { GenerateOpenApiOptions, OpenApiRouteSource, OpenApiWarn } from "./model.ts";
import { pathParameters } from "./route-path.ts";
import { bodySchemaRequiresValue, objectProperties, resolveSchema } from "./schema.ts";

interface RuntimeApiHandler {
  schemas?: ApiRouteSchemas;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

const VALIDATION_ERROR_SCHEMA: OpenApiSchema = {
  type: "object",
  required: ["error", "issues"],
  properties: {
    error: { const: "validation" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["in", "message"],
        properties: {
          in: { enum: ["body", "query", "params"] },
          message: { type: "string" },
          path: {
            type: "array",
            items: { type: ["string", "number"] },
          },
        },
      },
    },
  },
};

export async function buildOperation({
  handler,
  method,
  options,
  route,
  warn,
}: {
  handler: unknown;
  method: string;
  options: GenerateOpenApiOptions;
  route: OpenApiRouteSource;
  warn: OpenApiWarn;
}): Promise<OpenApiOperationObject> {
  const runtimeHandler = typeof handler === "function" ? (handler as RuntimeApiHandler) : undefined;
  const schemas = runtimeHandler?.schemas;
  const descriptor = getOpenApiDescriptor(handler);
  const responses = buildResponses(descriptor, schemas, options, route, method, warn);
  const operation: OpenApiOperationObject = {
    ...descriptorOperationFields(descriptor),
    responses,
  };

  const parameters = buildParameters(route, schemas, options, method, warn);
  if (parameters.length > 0) operation.parameters = parameters;

  if (schemas?.body && !BODYLESS_METHODS.has(method.toUpperCase())) {
    const schema = resolveSchema(schemas.body, "input", false, options, route, method, warn);
    if (schema) {
      operation.requestBody = {
        required: await bodySchemaRequiresValue(schemas.body),
        content: { "application/json": { schema } },
      };
    }
  }

  return operation;
}

function descriptorOperationFields(
  descriptor: OpenApiOperationDescriptor | undefined,
): Omit<OpenApiOperationObject, "parameters" | "requestBody" | "responses"> {
  if (!descriptor) return {};
  return {
    ...(descriptor.tags ? { tags: [...descriptor.tags] } : {}),
    ...(descriptor.summary ? { summary: descriptor.summary } : {}),
    ...(descriptor.description ? { description: descriptor.description } : {}),
    ...(descriptor.operationId ? { operationId: descriptor.operationId } : {}),
    ...(descriptor.deprecated !== undefined ? { deprecated: descriptor.deprecated } : {}),
    ...(descriptor.security
      ? {
          security: descriptor.security.map((requirement) =>
            Object.fromEntries(
              Object.entries(requirement).map(([name, scopes]) => [name, [...scopes]]),
            ),
          ),
        }
      : {}),
  };
}

function buildResponses(
  descriptor: OpenApiOperationDescriptor | undefined,
  schemas: ApiRouteSchemas | undefined,
  options: GenerateOpenApiOptions,
  route: OpenApiRouteSource,
  method: string,
  warn: OpenApiWarn,
): Record<string, OpenApiResponseObject> {
  const responses: Record<string, OpenApiResponseObject> = {};

  if (schemas?.body && !BODYLESS_METHODS.has(method.toUpperCase())) {
    responses["400"] = validationResponse("Request body could not be parsed.");
  }
  if (schemas?.body || schemas?.query || schemas?.params) {
    responses["422"] = validationResponse("Request validation failed.");
  }

  if (!descriptor) {
    responses.default = { description: "Response contract is not documented." };
    warn(
      route,
      "undocumented_response",
      "No OpenAPI response descriptor is attached; emitted an explicit undocumented default response.",
      method,
    );
    return responses;
  }

  for (const [rawStatus, response] of Object.entries(descriptor.responses)) {
    const status = rawStatus.toUpperCase() === "DEFAULT" ? "default" : rawStatus.toUpperCase();
    const generated: OpenApiResponseObject = { description: response.description };
    if (response.body) {
      const schema = resolveSchema(response.body, "output", true, options, route, method, warn);
      if (schema) {
        generated.content = {
          [response.contentType ?? "application/json"]: { schema },
        };
      }
    }
    responses[status] = generated;
  }

  return responses;
}

function validationResponse(description: string): OpenApiResponseObject {
  return {
    description,
    content: { "application/json": { schema: VALIDATION_ERROR_SCHEMA } },
  };
}

function buildParameters(
  route: OpenApiRouteSource,
  schemas: ApiRouteSchemas | undefined,
  options: GenerateOpenApiOptions,
  method: string,
  warn: OpenApiWarn,
): OpenApiParameterObject[] {
  const parameters: OpenApiParameterObject[] = [];
  const paramsSchema = schemas?.params
    ? resolveSchema(schemas.params, "input", false, options, route, method, warn)
    : undefined;
  const paramProperties = objectProperties(paramsSchema);

  for (const { name, schemaName } of pathParameters(route.path)) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: paramProperties?.[schemaName] ?? { type: "string" },
    });
  }

  if (schemas?.query) {
    const querySchema = resolveSchema(schemas.query, "input", false, options, route, method, warn);
    const queryProperties = objectProperties(querySchema);
    if (!queryProperties) {
      if (querySchema) {
        warn(
          route,
          "invalid_schema_shape",
          "Query schema did not convert to an object with properties, so query parameters were omitted.",
          method,
        );
      }
    } else {
      const required = new Set(
        Array.isArray(querySchema?.required)
          ? querySchema.required.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
      for (const [name, schema] of Object.entries(queryProperties)) {
        parameters.push({ name, in: "query", required: required.has(name), schema });
      }
    }
  }

  return parameters;
}
