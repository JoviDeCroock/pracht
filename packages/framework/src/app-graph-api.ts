import {
  apiExportsFromModule,
  detectApiExports,
  detectApiExportsStatic,
} from "./api-export-detection.ts";
import type {
  AppGraphApiRoute,
  AppGraphModuleAccess,
  AppGraphStaticModuleAccess,
  SerializeApiRoutesOptions,
} from "./app-graph-types.ts";
import type { ResolvedApiRoute } from "./types.ts";

export function serializeApiRoutes(
  apiRoutes: readonly ResolvedApiRoute[],
  access: AppGraphModuleAccess,
  options: SerializeApiRoutesOptions = {},
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => {
      try {
        const { hasDefaultHandler, methods } = options.strict
          ? apiExportsFromModule(await access.loadModule(route.file))
          : await detectApiExports(route.file, access);
        return {
          file: route.file,
          hasDefaultHandler,
          methods,
          path: route.path,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to load API route ${JSON.stringify(route.path)} from ${JSON.stringify(route.file)} while resolving the app graph: ${detail}`,
          { cause: error },
        );
      }
    }),
  );
}

/**
 * Serialize API method metadata without executing application modules.
 *
 * Used by the dev banner, where importing every API route at startup would run
 * unrelated top-level application work. Named re-exports expose their names
 * directly; star re-exports are followed through the caller's resolver.
 */
export function serializeApiRoutesStatic(
  apiRoutes: readonly ResolvedApiRoute[],
  access: AppGraphStaticModuleAccess,
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => {
      const { hasDefaultHandler, methods } = await detectApiExportsStatic(route.file, access);
      return {
        file: route.file,
        hasDefaultHandler,
        methods,
        path: route.path,
      };
    }),
  );
}
