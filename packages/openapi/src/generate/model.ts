import type {
  OpenApiDocument,
  OpenApiDocumentOptions,
  OpenApiInfo,
  OpenApiSchemaResolver,
  OpenApiWarning,
  OpenApiWarningCode,
} from "../types.ts";

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

export type OpenApiWarn = (
  route: OpenApiRouteSource,
  code: OpenApiWarningCode,
  message: string,
  method?: string,
) => void;
