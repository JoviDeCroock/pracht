import {
  cloudflareAdapter,
  createCloudflareFetchHandler,
  createCloudflareServerEntryModule,
  type CloudflareAdapterOptions,
  type CloudflareContextArgs,
  type CloudflareExecutionContext,
  type CloudflareFetcher,
  type CloudflareServerEntryModuleOptions,
} from "@pracht/adapter-cloudflare";
import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin, UserConfig } from "vite";
import { withRuntimeEnv } from "void/_env";

export type {
  CloudflareAdapterOptions,
  CloudflareContextArgs,
  CloudflareExecutionContext,
  CloudflareFetcher,
  CloudflareServerEntryModuleOptions,
};

export type VoidAdapterRuntimeOptions = CloudflareAdapterOptions;
export type VoidContextArgs = CloudflareContextArgs;
export type VoidExecutionContext = CloudflareExecutionContext;
export type VoidFetcher = CloudflareFetcher;
export type VoidAdapterOptions = CloudflareServerEntryModuleOptions;
export type VoidServerEntryModuleOptions = CloudflareServerEntryModuleOptions;

export function createVoidFetchHandler<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  TContext = {
    env: TEnv;
    executionContext: CloudflareExecutionContext;
  },
>(options: CloudflareAdapterOptions<TEnv, TContext>) {
  const handler = createCloudflareFetchHandler(options);

  return (
    request: Request,
    env: TEnv,
    executionContext: CloudflareExecutionContext,
  ): Promise<Response> => {
    return withRuntimeEnv(env, () => handler(request, env, executionContext));
  };
}

export function createVoidServerEntryModule(options: VoidServerEntryModuleOptions = {}): string {
  const source = createCloudflareServerEntryModule(options);

  return [
    'import { withRuntimeEnv as withVoidRuntimeEnv } from "void/_env";',
    source
      .replace(
        "async function fetch(request, env, executionContext) {\n",
        "async function fetch(request, env, executionContext) {\n  return withVoidRuntimeEnv(env, async () => {\n",
      )
      // The Cloudflare entry's default export may carry extra worker handlers
      // (`export default { ...prachtWorkerHandlers, fetch };`), so anchor the
      // wrapper's closing on the stable `export default {` prefix rather than
      // the exact object literal.
      .replace("\n}\n\nexport default {", "\n  });\n}\n\nexport default {"),
  ].join("\n");
}

/**
 * Create a pracht adapter for Void deploys.
 *
 * The generated runtime is a standard Cloudflare Worker with `dist/client`
 * assets. Build with `pracht build`, then deploy the existing output with
 * `void deploy --skip-build`.
 *
 * ```ts
 * import { voidAdapter } from "@pracht/adapter-void";
 * pracht({ adapter: voidAdapter() })
 * ```
 */
export function voidAdapter(options: VoidAdapterOptions = {}): PrachtAdapter {
  const adapter = cloudflareAdapter(options);

  return {
    ...adapter,
    id: "void",
    createServerEntryModule() {
      return createVoidServerEntryModule(options);
    },
    vitePlugins(): Plugin[] {
      return [...(adapter.vitePlugins?.() ?? []), cloudflareBuiltinsExternalPlugin()];
    },
  };
}

function cloudflareBuiltinsExternalPlugin(): Plugin {
  return {
    name: "pracht:void-cloudflare-builtins-external",
    config() {
      return {
        build: {
          rollupOptions: {
            external: [/^cloudflare:/],
          },
        },
      } satisfies UserConfig;
    },
    resolveId(source) {
      if (source.startsWith("cloudflare:")) {
        return { external: true, id: source };
      }
      return null;
    },
  };
}
