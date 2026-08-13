import type {
  OpenApiDocument,
  OpenApiDocumentOptions,
  OpenApiPathItemObject,
  OpenApiWarning,
} from "../types.ts";
import type { GenerateOpenApiOptions, GenerateOpenApiResult, OpenApiWarn } from "./model.ts";
import { buildOperation } from "./operation.ts";
import { toOpenApiPath } from "./route-path.ts";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

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

  const warn: OpenApiWarn = (route, code, message, method) => {
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
      const operation = await buildOperation({
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
