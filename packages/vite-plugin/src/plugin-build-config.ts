import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, type ConfigEnv, type UserConfig } from "vite";

import { hasAgentSurface, hasWebmcpCapabilities } from "./plugin-capabilities.ts";
import { PRACHT_ISLANDS_CLIENT_MODULE_ID } from "./plugin-assets.ts";
import { PUBLIC_ENV_PREFIX } from "./env-safety.ts";
import { PREACT_DEDUPE } from "./plugin-optimize-deps.ts";
import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";
import { resolveConfigPath } from "./plugin-paths.ts";

/**
 * Build the Vite configuration contributed by the Pracht plugin.
 *
 * Keeping target and bundle policy outside the plugin lifecycle coordinator
 * makes client, Node SSR, and edge SSR configuration reviewable as one focused
 * unit without mixing it with virtual-module and development-server hooks.
 */
export function createPrachtBuildConfig(
  resolved: ResolvedPrachtPluginOptions,
  config: UserConfig,
  env: ConfigEnv,
): UserConfig {
  const isEdge = resolved.adapter.edge === true;
  const isSSRBuild = env.isSsrBuild;

  // Emit the islands bootstrap as its own client entry so islands-mode routes
  // can load it without the full client runtime. WebMCP also owns this entry on
  // islands routes, including responses that render no island components and
  // apps that have no islands directory.
  const configRoot = config.root ?? process.cwd();
  const wantsIslandsEntry =
    env.command === "build" &&
    !isSSRBuild &&
    (existsSync(resolveConfigPath(configRoot, resolved.islandsDir)) ||
      hasWebmcpCapabilities(resolved, configRoot));

  // `publicEnv` needs every PRACHT_PUBLIC_ key, but reading the whole
  // `import.meta.env` object to enumerate them makes Vite inline *all* exposed
  // vars — VITE_ ones included — into the client bundle. Injecting the
  // pre-filtered subset keeps that enumeration public-only.
  const envDir = config.envDir ? resolve(configRoot, config.envDir) : configRoot;
  const publicEnvDefine = JSON.stringify(loadEnv(env.mode, envDir, PUBLIC_ENV_PREFIX));

  // Apps that register no capabilities and configure no agents get the
  // capability + Web Bot Auth runtimes dead-code-eliminated out of the server
  // bundle instead of shipping them unused. Build only: `config()` runs once,
  // and in dev the manifest is edited live — a stale `false` would make a
  // freshly added capability 404 until the server restarts.
  const agentSurfaceDefine =
    env.command === "build" ? String(hasAgentSurface(resolved, configRoot)) : "true";

  return {
    appType: "custom",
    // Expose PRACHT_PUBLIC_-prefixed vars on import.meta.env (client and server)
    // while keeping Vite's default VITE_ prefix working.
    envPrefix: ["VITE_", PUBLIC_ENV_PREFIX],
    resolve: {
      // Preact's hook state lives in module-level `options` on the Preact
      // instance that rendered the tree. A second copy in the graph — from
      // hoisting, a linked package, or a UI library with its own Preact
      // dependency — makes any hook-using component die during SSR with
      // `Cannot read properties of undefined (reading '__H')`, which names
      // neither the component nor the cause. Collapsing the family onto one
      // copy is the only sane default.
      dedupe: PREACT_DEDUPE,
    },
    define: {
      __PRACHT_PUBLIC_ENV__: publicEnvDefine,
      __PRACHT_AGENT_SURFACE__: agentSurfaceDefine,
    },
    // The vendor split only makes sense for the client bundle; SSR builds that
    // disable code splitting (e.g. webworker targets) reject `manualChunks`.
    ...(isSSRBuild
      ? {}
      : {
          build: {
            rollupOptions: {
              ...(wantsIslandsEntry ? { input: [PRACHT_ISLANDS_CLIENT_MODULE_ID] } : {}),
              output: {
                manualChunks(id: string) {
                  if (
                    id.includes("node_modules/preact") ||
                    id.includes("node_modules/preact-suspense")
                  ) {
                    return "vendor";
                  }
                },
              },
            },
          },
        }),
    ...(isEdge && isSSRBuild
      ? {
          ssr: {
            noExternal: true,
            // Edge server bundles run outside Node; without this the SSR build
            // emits Node-flavored CJS interop (`createRequire(import.meta.url)`)
            // that workerd rejects at startup.
            target: "webworker" as const,
          },
          // `ssr.target: "webworker"` applies the client condition list, so a
          // package's `browser` entry wins in a server bundle. Correct that
          // resolution without enabling `keepProcessEnv`: preserving raw
          // `process.env` reads across the entire noExternal bundle would make
          // unguarded dependency code throw on Cloudflare.
          environments: {
            ssr: {
              resolve: {
                // The client list resolved `@pracht/core/env/server` to the stub
                // that exists to make a *client* import fail loudly. `worker`
                // goes first so worker-aware packages can answer an edge server
                // build with server code; `browser` keeps browser-only
                // dependencies resolvable.
                conditions: ["worker", "module", "browser", "development|production"],
                // Rolldown's generated interop runtime references `node:module`
                // while deciding whether a helper is needed. Edge builds
                // tree-shake that helper; explicit externalization keeps a
                // successful Worker build quiet, while the runtime-safety plugin
                // still rejects any surviving Node import.
                external: ["node:module"],
              },
            },
          },
          build: {
            rollupOptions: {
              // Platform-scheme modules only exist inside the target runtime
              // and must stay runtime imports.
              external: [/^cloudflare:/],
            },
          },
        }
      : {}),
  };
}
