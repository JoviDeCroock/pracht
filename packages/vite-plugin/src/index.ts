import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";
import preact from "@preact/preset-vite";
import type { Plugin } from "vite";

import type { RenderMode } from "@pracht/core";
import { PRACHT_GRAPH_ONLY_ENV } from "@pracht/core/server";
import { createEnvSafetyPlugin, PUBLIC_ENV_PREFIX, SERVER_ENV_MODULE_ID } from "./env-safety.ts";
import { handlePrachtHotUpdate, watchPagesDirectory } from "./plugin-hot-update.ts";
import {
  PRACHT_CAPABILITIES_MODULE_ID,
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_DEV_MODULE_ID,
  PRACHT_ISLANDS_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  PRACHT_WEBMCP_MODULE_ID,
  isCapabilitiesModule,
  isClientModule,
  isDevModule,
  isIslandsClientModule,
  isServerModule,
  isWebmcpModule,
} from "./plugin-assets.ts";
import {
  createPrachtCapabilitiesClientModuleSource,
  createPrachtWebmcpModuleSource,
} from "./capability-browser-codegen.ts";
import { createClientModuleSafetyPlugin } from "./plugin-client-safety.ts";
import { createPrachtBuildConfig } from "./plugin-build-config.ts";
import {
  createPrachtClientModuleSource,
  createPrachtDevModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
} from "./plugin-codegen.ts";
import { createDevCssInjectionMiddleware } from "./plugin-dev-css-middleware.ts";
import { injectDevCssForPath } from "./plugin-dev-css-route.ts";
import { createDevSSRMiddleware } from "./plugin-dev-ssr.ts";
import { createEdgeRuntimeSafetyPlugin } from "./plugin-edge-runtime-safety.ts";
import { transformAppManifestModule } from "./plugin-manifest-transform.ts";
import { createOptimizeDepsPlugin } from "./plugin-optimize-deps.ts";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export type { RenderMode };
export type { PrachtAdapter } from "./plugin-adapter.ts";
export type {
  LlmsTxtSection,
  PrachtLlmsTxtOptions,
  PrachtPluginOptions,
} from "./plugin-options.ts";
export {
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
  createPrachtRegistryModuleSource,
} from "./plugin-codegen.ts";
export {
  createEnvSafetyPlugin,
  formatEnvLeakError,
  PUBLIC_ENV_PREFIX,
  scanCodeForEnvLeaks,
  VITE_BUILTIN_ENV_VARS,
  type EnvLeakReference,
  type EnvSafetyOptions,
} from "./env-safety.ts";
export {
  createPrachtCapabilitiesClientModuleSource,
  createPrachtWebmcpModuleSource,
} from "./capability-browser-codegen.ts";
export { extractCapabilities } from "./plugin-capabilities.ts";
export {
  PRACHT_CAPABILITIES_MODULE_ID,
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_ISLANDS_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  PRACHT_WEBMCP_MODULE_ID,
};

export function pracht(options: PrachtPluginOptions = {}): Plugin[] {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  let root = process.cwd();

  if (isPagesMode && options.appFile) {
    console.warn(
      "[pracht] Both `pagesDir` and `appFile` are set. `pagesDir` takes precedence — `appFile` will be ignored.",
    );
  }

  let isBuild = false;

  const prachtPlugin: Plugin = {
    name: "pracht",
    enforce: "pre",

    config(config, env) {
      return createPrachtBuildConfig(resolved, config, env);
    },

    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
    },

    resolveId(id, importer, resolveIdOptions) {
      if (isIslandsClientModule(id)) return PRACHT_ISLANDS_CLIENT_MODULE_ID;
      if (isClientModule(id)) return PRACHT_CLIENT_MODULE_ID;
      if (isDevModule(id)) return PRACHT_DEV_MODULE_ID;
      if (isServerModule(id)) return PRACHT_SERVER_MODULE_ID;
      if (isCapabilitiesModule(id)) return PRACHT_CAPABILITIES_MODULE_ID;
      if (isWebmcpModule(id)) return PRACHT_WEBMCP_MODULE_ID;

      // Fail loudly when client code imports the server-only env entry.
      // `scan` resolutions (dep optimizer discovery) are skipped because the
      // scanner does not run the client transform that strips server-only
      // exports (and their now-unused imports) from route files.
      if (
        id === SERVER_ENV_MODULE_ID &&
        !resolveIdOptions?.ssr &&
        !(resolveIdOptions as { scan?: boolean } | undefined)?.scan
      ) {
        throw new Error(
          `[pracht] ${JSON.stringify(SERVER_ENV_MODULE_ID)} was imported by ` +
            `${JSON.stringify(importer ?? "unknown module")} in client code. serverEnv is ` +
            "server-only — read it inside loaders, middleware, or API routes, or use " +
            `publicEnv (PRACHT_PUBLIC_-prefixed variables) from "@pracht/core" instead.`,
        );
      }

      return null;
    },

    load(id) {
      if (isIslandsClientModule(id)) {
        return createPrachtIslandsClientModuleSource(resolved, { root });
      }
      if (isClientModule(id)) {
        return createPrachtClientModuleSource(resolved, { root });
      }
      if (isDevModule(id)) {
        return createPrachtDevModuleSource(resolved, { root });
      }
      if (isServerModule(id)) {
        return createPrachtServerModuleSource(resolved, { root, isBuild });
      }
      if (isCapabilitiesModule(id)) {
        return createPrachtCapabilitiesClientModuleSource(resolved, { root });
      }
      if (isWebmcpModule(id)) {
        return createPrachtWebmcpModuleSource(resolved, { root });
      }
      return null;
    },

    transform(code, id) {
      return transformAppManifestModule(code, id, {
        appFile: resolved.appFile,
        root,
      });
    },

    configureServer(server) {
      if (isPagesMode) {
        watchPagesDirectory(server, resolved, root);
      }

      if (resolved.adapter.ownsDevServer) {
        server.middlewares.use(createDevCssInjectionMiddleware(server));
        return;
      }
      return () => {
        server.middlewares.use(
          createDevSSRMiddleware(server, {
            llmsTxt: !!resolved.llmsTxt,
            maxBodySize: resolved.maxBodySize,
          }),
        );
      };
    },

    async transformIndexHtml(html, context) {
      if (isBuild || !context.server || !html.includes("</head>")) return html;

      try {
        return await injectDevCssForPath(context.server, context.path, html);
      } catch {
        // The original request path owns development error reporting. CSS
        // discovery must not replace its overlay or response with a second
        // module-loading failure from this HTML transform.
        return html;
      }
    },

    handleHotUpdate({ file, server }) {
      return handlePrachtHotUpdate({ file, server }, resolved);
    },
  };

  const clientModuleTransformPlugin = createClientModuleSafetyPlugin(resolved, () => root);

  const edgeRuntimeSafetyPlugin: Plugin | null = resolved.adapter.edge
    ? createEdgeRuntimeSafetyPlugin()
    : null;

  const optimizeDepsEntriesPlugin = createOptimizeDepsPlugin(resolved);

  const precompilePlugin = resolved.precompileSsrJsx
    ? preactSsrPrecompile({
        ...(resolved.precompileSsrJsx === true ? {} : resolved.precompileSsrJsx),
        ssrOnly: true,
      })
    : null;

  const plugins: Plugin[] = [
    ...(precompilePlugin ? [precompilePlugin] : []),
    ...preact(),
    prachtPlugin,
    clientModuleTransformPlugin,
    ...(edgeRuntimeSafetyPlugin ? [edgeRuntimeSafetyPlugin] : []),
    createEnvSafetyPlugin(resolved.envSafety),
  ];

  // Graph-only mode: the CLI's short-lived Vite server (`pracht inspect`,
  // `verify`, `doctor`, `plan`, `report`, `typegen`) evaluates adapter-neutral
  // metadata and closes immediately. Deployment runtimes can own resources
  // that outlive `server.close()`, so adapters must opt plugins into this mode
  // explicitly through the graph-safe hook.
  const adapterPlugins = isGraphOnlyMode()
    ? resolved.adapter.graphVitePlugins?.()
    : resolved.adapter.vitePlugins?.();
  if (adapterPlugins?.length) {
    plugins.push(...adapterPlugins);
  }
  plugins.push(optimizeDepsEntriesPlugin);

  return plugins;
}

function isGraphOnlyMode(): boolean {
  return process.env[PRACHT_GRAPH_ONLY_ENV] === "1";
}
