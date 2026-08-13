/**
 * Public OpenAPI document-generation entry point.
 *
 * Keep this facade stable while graph traversal, operation assembly, schema
 * conversion, and route-path translation evolve independently.
 */
export { generateOpenApiDocument } from "./generate/document.ts";
export type {
  GenerateOpenApiOptions,
  GenerateOpenApiResult,
  OpenApiRouteSource,
} from "./generate/model.ts";
