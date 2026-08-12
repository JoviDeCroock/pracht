import { createRequire } from "node:module";
import { join } from "node:path";
import type { Plugin, UserConfig } from "vite";

import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";

// Package names only: Vite matches `dedupe` against the bare package id, so a
// subpath entry such as `preact/hooks` would never match. Deduping `preact`
// already covers every subpath, since they all resolve through that package —
// and with them the `options` object `preact/hooks` mutates, which is the
// state a second copy splits in two.
export const PREACT_DEDUPE = ["preact", "preact-render-to-string"];

// Client-side dependencies the scanner can never discover on its own: the
// virtual client entry imports `@pracht/core/client`, and the plugin's
// transforms inject `@pracht/core/manifest` imports after scanning. Without
// pre-bundling them, the first browser hit triggers a re-optimize + full
// reload that aborts in-flight module requests mid-hydration. `@pracht/core`
// is included alongside them so user imports share the same optimized chunk
// graph (a source copy next to a pre-bundled client copy splits the runtime
// context in two).
const PRACHT_OPTIMIZE_DEPS_INCLUDE = [
  "@pracht/core",
  "@pracht/core/client",
  "@pracht/core/islands-client",
  "@pracht/core/manifest",
];

/** Add Pracht's generated and virtual client dependencies to Vite's scan. */
export function createOptimizeDepsPlugin(resolved: ResolvedPrachtPluginOptions): Plugin {
  return {
    name: "pracht:optimize-deps-entries",
    enforce: "post",

    config(config) {
      return withPrachtOptimizeDepsEntries(
        config,
        createPrachtOptimizeDepsEntries(resolved),
        createPrachtOptimizeDepsInclude(config.root ?? process.cwd()),
      );
    },
  };
}

function createPrachtOptimizeDepsInclude(root: string): string[] {
  // Vite deliberately leaves workspace-linked packages un-optimized (they are
  // treated as source). Force-including only some `@pracht/core` entries in
  // that setup would create a pre-bundled copy of the runtime next to the
  // linked source copy and split the router context in two — so the includes
  // only apply when the app resolves `@pracht/core` from node_modules.
  try {
    const require = createRequire(join(root, "package.json"));
    const corePackagePath = toPosixPath(require.resolve("@pracht/core/package.json"));
    if (!corePackagePath.includes("/node_modules/")) return [];
    return PRACHT_OPTIMIZE_DEPS_INCLUDE;
  } catch {
    return [];
  }
}

function withPrachtOptimizeDepsEntries(
  config: UserConfig,
  prachtEntries: string[],
  prachtInclude: string[],
): UserConfig {
  const environments = Object.fromEntries(
    Object.entries(config.environments ?? {}).map(([name, environment]) => [
      name,
      {
        optimizeDeps: {
          entries: mergeOptimizeDepsEntries(environment.optimizeDeps?.entries, prachtEntries),
        },
      },
    ]),
  );

  return {
    optimizeDeps: {
      entries: mergeOptimizeDepsEntries(config.optimizeDeps?.entries, prachtEntries),
      ...(prachtInclude.length > 0
        ? { include: mergeOptimizeDepsEntries(config.optimizeDeps?.include, prachtInclude) }
        : {}),
    },
    ...(Object.keys(environments).length > 0 ? { environments } : {}),
  };
}

function createPrachtOptimizeDepsEntries(resolved: ResolvedPrachtPluginOptions): string[] {
  const scriptExtensions = "{ts,tsx,js,jsx}";
  const routeExtensions = "{ts,tsx,js,jsx,md,mdx,tsrx}";
  const apiDir = toOptimizeDepsEntry(resolved.apiDir);
  const apiEntries = [`${apiDir}/**/*.{ts,js,tsx,jsx}`, `!${apiDir}/**/*.d.ts`];
  const entries = resolved.pagesDir
    ? [
        `${toOptimizeDepsEntry(resolved.pagesDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.middlewareDir)}/**/*.${scriptExtensions}`,
        ...apiEntries,
        `${toOptimizeDepsEntry(resolved.serverDir)}/**/*.{ts,js,tsx,jsx}`,
        `${toOptimizeDepsEntry(resolved.islandsDir)}/**/*.${scriptExtensions}`,
      ]
    : [
        toOptimizeDepsEntry(resolved.appFile),
        `${toOptimizeDepsEntry(resolved.routesDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.shellsDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.middlewareDir)}/**/*.${scriptExtensions}`,
        ...apiEntries,
        `${toOptimizeDepsEntry(resolved.serverDir)}/**/*.{ts,js,tsx,jsx}`,
        `${toOptimizeDepsEntry(resolved.islandsDir)}/**/*.${scriptExtensions}`,
        `${toOptimizeDepsEntry(resolved.capabilitiesDir)}/**/*.{ts,js,tsx,jsx}`,
      ];

  return [...new Set(entries.filter(Boolean))];
}

function mergeOptimizeDepsEntries(
  userEntries: string | string[] | undefined,
  prachtEntries: string[],
): string[] {
  const normalizedUserEntries = Array.isArray(userEntries)
    ? userEntries
    : userEntries
      ? [userEntries]
      : [];
  return [...new Set([...normalizedUserEntries, ...prachtEntries])];
}

function toOptimizeDepsEntry(path: string): string {
  return toPosixPath(path).replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}
