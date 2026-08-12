import type { PrachtAdapter } from "@pracht/vite-plugin";

import { createVercelServerEntryModule } from "./server-entry.js";
import type { VercelServerEntryModuleOptions } from "./types.js";

export { createVercelEdgeHandler } from "./edge-handler.js";
export { createVercelNodeListener } from "./node-listener.js";
export { createVercelServerEntryModule } from "./server-entry.js";
export type {
  VercelAdapterOptions,
  VercelContextArgs,
  VercelExecutionContext,
  VercelNodeRequest,
  VercelNodeResponse,
  VercelServerEntryModuleOptions,
} from "./types.js";

/**
 * Create a pracht adapter for Vercel Edge Functions.
 *
 * ```ts
 * import { vercelAdapter } from "@pracht/adapter-vercel";
 * pracht({ adapter: vercelAdapter() })
 * ```
 *
 * Native ISG prerender routes receive separate Node serverless entry points.
 */
export function vercelAdapter(options: VercelServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "vercel",
    edge: true,
    serverImports:
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createVercelEdgeHandler, createVercelNodeListener } from "@pracht/adapter-vercel";',
    createServerEntryModule() {
      return createVercelServerEntryModule(options);
    },
  };
}
