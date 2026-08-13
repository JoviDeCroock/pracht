import type { Plugin } from "vite";

import { createOpenApiDevMiddleware, warnPublicArtifactCollisions } from "./vite/dev-server.ts";
import { createOpenApiServerModuleSource, isPrachtGraphModule } from "./vite/graph-codegen.ts";
import type { PrachtOpenApiOptions } from "./vite/model.ts";
import { resolvePrachtOpenApiOptions } from "./vite/options.ts";

export type {
  PrachtOpenApiArtifact,
  PrachtOpenApiArtifacts,
  PrachtOpenApiOptions,
  PrachtOpenApiUiOptions,
} from "./vite/model.ts";
export { resolvePrachtOpenApiOptions } from "./vite/options.ts";

/**
 * Add live OpenAPI JSON/reference endpoints and matching static build assets
 * without changing ordinary Pracht route authoring.
 */
export function prachtOpenApi(options: PrachtOpenApiOptions): Plugin {
  const resolved = resolvePrachtOpenApiOptions(options);
  const warned = new Set<string>();

  return {
    name: "pracht:openapi",

    configureServer(server) {
      warnPublicArtifactCollisions(server, resolved);
      server.middlewares.use(createOpenApiDevMiddleware(server, resolved, warned));
    },

    transform(code, id) {
      if (!isPrachtGraphModule(id)) return null;
      return {
        code: `${code}\n${createOpenApiServerModuleSource(resolved)}`,
        map: null,
      };
    },
  };
}
