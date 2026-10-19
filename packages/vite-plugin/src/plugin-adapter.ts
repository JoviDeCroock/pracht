import { createNodeServerEntryModule } from "@pracht/adapter-node";
import type { PrachtAdapter } from "@pracht/core/adapter";

// The adapter contract lives in `@pracht/core/adapter`; this package keeps
// re-exporting it under the same names.
export type {
  PrachtAdapter,
  PrachtAdapterBuildContext,
  PrachtAdapterDevOptions,
  PrachtAdapterDevRequest,
  PrachtServerEntryFeatures,
  PrachtServerEntryModuleContext,
} from "@pracht/core/adapter";

export function createDefaultNodeAdapter(): PrachtAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    features: { headersManifest: 2 },
    createServerEntryModule(entry) {
      return createNodeServerEntryModule({}, entry);
    },
  };
}
