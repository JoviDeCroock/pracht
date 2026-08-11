export type OpenApiSchema = Record<string, unknown>;

export interface OpenApiInfo {
  title: string;
  version: string;
  summary?: string;
  description?: string;
  termsOfService?: string;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name: string;
    identifier?: string;
    url?: string;
  };
}

export interface OpenApiServerObject {
  url: string;
  description?: string;
  variables?: Record<
    string,
    {
      default: string;
      description?: string;
      enum?: string[];
    }
  >;
}

export interface OpenApiTagObject {
  name: string;
  description?: string;
  externalDocs?: OpenApiExternalDocumentationObject;
}

export interface OpenApiExternalDocumentationObject {
  url: string;
  description?: string;
}

export interface OpenApiSecuritySchemeObject extends Record<string, unknown> {
  type: "apiKey" | "http" | "mutualTLS" | "oauth2" | "openIdConnect" | string;
  description?: string;
}

export interface OpenApiComponentsObject {
  schemas?: Record<string, OpenApiSchema>;
  securitySchemes?: Record<string, OpenApiSecuritySchemeObject>;
  [componentType: string]: Record<string, unknown> | undefined;
}

export interface OpenApiDocumentOptions {
  servers?: readonly OpenApiServerObject[];
  tags?: readonly OpenApiTagObject[];
  externalDocs?: OpenApiExternalDocumentationObject;
  security?: readonly Record<string, readonly string[]>[];
  components?: OpenApiComponentsObject;
}

export interface OpenApiMediaTypeObject {
  schema?: OpenApiSchema;
}

export interface OpenApiResponseObject {
  description: string;
  content?: Record<string, OpenApiMediaTypeObject>;
}

export interface OpenApiParameterObject {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema: OpenApiSchema;
}

export interface OpenApiRequestBodyObject {
  required?: boolean;
  content: Record<string, OpenApiMediaTypeObject>;
}

export interface OpenApiOperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  parameters?: OpenApiParameterObject[];
  requestBody?: OpenApiRequestBodyObject;
  responses: Record<string, OpenApiResponseObject>;
}

export interface OpenApiPathItemObject {
  get?: OpenApiOperationObject;
  post?: OpenApiOperationObject;
  put?: OpenApiOperationObject;
  patch?: OpenApiOperationObject;
  delete?: OpenApiOperationObject;
  head?: OpenApiOperationObject;
  options?: OpenApiOperationObject;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: OpenApiInfo;
  paths: Record<string, OpenApiPathItemObject>;
  servers?: OpenApiServerObject[];
  tags?: OpenApiTagObject[];
  externalDocs?: OpenApiExternalDocumentationObject;
  security?: Record<string, string[]>[];
  components?: OpenApiComponentsObject;
}

/** A raw JSON Schema or an object implementing Standard JSON Schema. */
export type OpenApiSchemaSource = object;

export interface OpenApiResponseDescriptor {
  description: string;
  /** Response payload schema. Standard JSON Schema converters use their output projection. */
  body?: OpenApiSchemaSource;
  /** Defaults to `application/json` when `body` is present. */
  contentType?: string;
}

export interface OpenApiOperationDescriptor {
  tags?: readonly string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  security?: readonly Record<string, readonly string[]>[];
  responses: Readonly<Record<string | number, OpenApiResponseDescriptor>>;
}

export type OpenApiWarningCode =
  | "catch_all_path"
  | "default_handler_omitted"
  | "invalid_schema_shape"
  | "route_module_load_failed"
  | "schema_conversion_failed"
  | "schema_conversion_unavailable"
  | "undocumented_response";

export interface OpenApiWarning {
  code: OpenApiWarningCode;
  file: string;
  message: string;
  method?: string;
  path: string;
}

export type OpenApiSchemaDirection = "input" | "output";

export type OpenApiSchemaResolver = (
  schema: object,
  direction: OpenApiSchemaDirection,
) => OpenApiSchema | null | undefined;
