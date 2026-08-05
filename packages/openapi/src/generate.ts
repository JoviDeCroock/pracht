import type { ApiRouteSchemas } from "@pracht/core";

import { getOpenApiDescriptor } from "./descriptor.ts";
import type {
  OpenApiDocument,
  OpenApiDocumentOptions,
  OpenApiInfo,
  OpenApiOperationDescriptor,
  OpenApiOperationObject,
  OpenApiParameterObject,
  OpenApiPathItemObject,
  OpenApiResponseObject,
  OpenApiSchema,
  OpenApiSchemaDirection,
  OpenApiSchemaResolver,
  OpenApiWarning,
  OpenApiWarningCode,
} from "./types.ts";

interface RuntimeApiHandler {
  schemas?: ApiRouteSchemas;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export interface GenerateOpenApiOptions {
  info: OpenApiInfo;
  /** Document-level servers, tags, security schemes, and reusable components. */
  document?: OpenApiDocumentOptions;
  /**
   * Resolved Pracht API routes. `methods` and `hasDefaultHandler` may be
   * omitted when `loadModule` can inspect the route module at generation time.
   */
  routes: readonly OpenApiRouteSource[];
  loadModule: (file: string) => Promise<Record<string, unknown>>;
  /** Optional converter for schema libraries that do not implement Standard JSON Schema directly. */
  resolveSchema?: OpenApiSchemaResolver;
  onWarning?: (warning: OpenApiWarning) => void;
}

export interface OpenApiRouteSource {
  file: string;
  path: string;
  methods?: readonly string[];
  hasDefaultHandler?: boolean;
}

export interface GenerateOpenApiResult {
  document: OpenApiDocument;
  warnings: OpenApiWarning[];
}

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

/** Generate an OpenAPI 3.1 document from Pracht's serialized API graph. */
export async function generateOpenApiDocument(
  options: GenerateOpenApiOptions,
): Promise<GenerateOpenApiResult> {
  const warnings: OpenApiWarning[] = [];
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: { ...options.info },
    paths: {},
    ...documentFields(options.document),
  };

  const warn = (
    route: OpenApiRouteSource,
    code: OpenApiWarningCode,
    message: string,
    method?: string,
  ) => {
    const warning: OpenApiWarning = {
      code,
      file: route.file,
      message,
      method,
      path: route.path,
    };
    warnings.push(warning);
    options.onWarning?.(warning);
  };

  for (const route of options.routes) {
    let module: Record<string, unknown> = {};
    try {
      module = await options.loadModule(route.file);
    } catch (error) {
      warn(
        route,
        "route_module_load_failed",
        `Could not load API route module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const methods = route.methods ?? discoverMethods(module);
    const hasDefaultHandler = route.hasDefaultHandler ?? typeof module.default === "function";
    const openApiPath = toOpenApiPath(route.path);
    if (route.path.includes("*")) {
      warn(
        route,
        "catch_all_path",
        `Catch-all route ${JSON.stringify(route.path)} is represented as a single {path} parameter; clients may need custom slash encoding.`,
      );
    }

    const pathItem = (document.paths[openApiPath] ??= {});
    for (const method of methods) {
      const operation = buildOperation({
        handler: module[method],
        method,
        options,
        route,
        warn,
      });
      pathItem[method.toLowerCase() as keyof OpenApiPathItemObject] = operation;
    }

    if (hasDefaultHandler) {
      warn(
        route,
        "default_handler_omitted",
        "The default handler can branch on any HTTP method, so it is omitted until methods are documented explicitly.",
      );
    }
  }

  return { document, warnings };
}

function documentFields(
  options: OpenApiDocumentOptions | undefined,
): Omit<OpenApiDocument, "info" | "openapi" | "paths"> {
  if (!options) return {};
  return {
    ...(options.servers ? { servers: options.servers.map((server) => ({ ...server })) } : {}),
    ...(options.tags ? { tags: options.tags.map((tag) => ({ ...tag })) } : {}),
    ...(options.externalDocs ? { externalDocs: { ...options.externalDocs } } : {}),
    ...(options.security
      ? {
          security: options.security.map((requirement) =>
            Object.fromEntries(
              Object.entries(requirement).map(([name, scopes]) => [name, [...scopes]]),
            ),
          ),
        }
      : {}),
    ...(options.components ? { components: { ...options.components } } : {}),
  };
}

function discoverMethods(module: Record<string, unknown>): string[] {
  return HTTP_METHODS.filter((method) => typeof module[method] === "function");
}

function buildOperation({
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
  warn: (
    route: OpenApiRouteSource,
    code: OpenApiWarningCode,
    message: string,
    method?: string,
  ) => void;
}): OpenApiOperationObject {
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

  if (schemas?.body) {
    const schema = resolveSchema(schemas.body, "input", false, options, route, method, warn);
    if (schema) {
      operation.requestBody = {
        required: true,
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
  warn: (
    route: OpenApiRouteSource,
    code: OpenApiWarningCode,
    message: string,
    method?: string,
  ) => void,
): Record<string, OpenApiResponseObject> {
  const responses: Record<string, OpenApiResponseObject> = {};

  if (schemas?.body) {
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
  warn: (
    route: OpenApiRouteSource,
    code: OpenApiWarningCode,
    message: string,
    method?: string,
  ) => void,
): OpenApiParameterObject[] {
  const parameters: OpenApiParameterObject[] = [];
  const paramsSchema = schemas?.params
    ? resolveSchema(schemas.params, "input", false, options, route, method, warn)
    : undefined;
  const paramProperties = objectProperties(paramsSchema);

  for (const name of pathParameterNames(route.path)) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: paramProperties?.[name] ?? { type: "string" },
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

function resolveSchema(
  source: object,
  direction: OpenApiSchemaDirection,
  allowRawSchema: boolean,
  options: GenerateOpenApiOptions,
  route: OpenApiRouteSource,
  method: string,
  warn: (
    route: OpenApiRouteSource,
    code: OpenApiWarningCode,
    message: string,
    method?: string,
  ) => void,
): OpenApiSchema | undefined {
  try {
    const custom = options.resolveSchema?.(source, direction);
    if (custom) return custom;

    const converter = standardJsonSchemaConverter(source);
    if (converter) {
      return converter[direction]({ target: "draft-2020-12" });
    }

    if (allowRawSchema && isPlainObject(source) && !("~standard" in source)) {
      return source;
    }

    warn(
      route,
      "schema_conversion_unavailable",
      `The ${direction} schema does not implement Standard JSON Schema and no custom resolver converted it.`,
      method,
    );
  } catch (error) {
    warn(
      route,
      "schema_conversion_failed",
      `The ${direction} schema conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      method,
    );
  }
  return undefined;
}

function standardJsonSchemaConverter(source: object):
  | {
      input(options: { target: string }): OpenApiSchema;
      output(options: { target: string }): OpenApiSchema;
    }
  | undefined {
  const standard = (source as { "~standard"?: unknown })["~standard"];
  if (!isPlainObject(standard)) return undefined;
  const converter = standard.jsonSchema;
  if (!isPlainObject(converter)) return undefined;
  if (typeof converter.input !== "function" || typeof converter.output !== "function") {
    return undefined;
  }
  return converter as ReturnType<typeof standardJsonSchemaConverter>;
}

function objectProperties(schema: OpenApiSchema | undefined): Record<string, OpenApiSchema> | null {
  if (!schema || !isPlainObject(schema.properties)) return null;
  const properties: Record<string, OpenApiSchema> = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    if (isPlainObject(value)) properties[name] = value;
  }
  return properties;
}

function pathParameterNames(path: string): string[] {
  const names: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.startsWith(":")) names.push(segment.slice(1));
    if (segment === "*") names.push("path");
  }
  return names;
}

function toOpenApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return `{${segment.slice(1)}}`;
      if (segment === "*") return "{path}";
      return segment;
    })
    .join("/");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
