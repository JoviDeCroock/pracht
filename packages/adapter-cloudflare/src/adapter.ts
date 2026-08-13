import { cloudflare } from "@cloudflare/vite-plugin";
import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin } from "vite";

import { cloudflareGraphRuntimeStubs } from "./graph-runtime-stubs.ts";
import {
  createCloudflareServerEntryModule,
  type CloudflareServerEntryModuleOptions,
} from "./server-entry.ts";

export interface CloudflareViteAdapterOptions extends CloudflareServerEntryModuleOptions {
  /**
   * Inspector port for the local Cloudflare runtime, or `false` to disable it.
   * Set this explicitly when multiple Cloudflare Vite dev servers can start at
   * the same time; automatic availability probes can otherwise race.
   */
  inspectorPort?: number | false;
  /**
   * Persist local Cloudflare binding state, optionally below a custom path.
   * Use separate paths or `false` for concurrent dev servers in one project.
   * Defaults to Cloudflare's `.wrangler/state` behavior.
   */
  persistState?: boolean | { path: string };
}

/**
 * Create a pracht adapter for Cloudflare Workers.
 *
 * ```ts
 * import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
 * pracht({ adapter: cloudflareAdapter({ workerExportsFrom: "/src/cloudflare.ts" }) })
 * ```
 */
export function cloudflareAdapter(options: CloudflareViteAdapterOptions = {}): PrachtAdapter {
  return {
    id: "cloudflare",
    ownsDevServer: true,
    edge: true,
    serverImports:
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createCloudflareFetchHandler } from "@pracht/adapter-cloudflare/runtime";',
    createServerEntryModule() {
      return createCloudflareServerEntryModule(options);
    },
    graphVitePlugins(): Plugin[] {
      return [cloudflareGraphRuntimeStubs()];
    },
    vitePlugins(): Plugin[] {
      return cloudflare({
        config: {
          main: "virtual:pracht/server",
        },
        inspectorPort: options.inspectorPort,
        persistState: options.persistState,
      });
    },
  };
}
