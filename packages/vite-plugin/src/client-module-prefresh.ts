import type { Plugin, PluginOption } from "vite";

import { isPrachtClientModuleId, stripPrachtClientModuleQuery } from "./client-module-query.ts";

/**
 * Give route and shell modules Preact Fast Refresh.
 *
 * `@prefresh/vite` gates its transform on `/\.(c|m)?(t|j)sx?$/`, a pattern
 * anchored at the end of the id — so an id carrying a query never matches.
 * Pracht loads route and shell modules in the browser through
 * `import.meta.glob(..., { query: "?pracht-client" })` so its post transform
 * can strip server-only exports, which means the module the browser actually
 * runs is `/src/routes/home.tsx?pracht-client`. Prefresh skipped it, no
 * `import.meta.hot.accept` was injected, and with no self-accepting boundary
 * the update propagated to the non-accepting virtual client entry: every edit
 * to a route or a shell became a full page reload with client state loss.
 * Components outside those directories were unaffected, which is why this hid
 * for so long — Fast Refresh worked everywhere except the files a route-based
 * framework is mostly made of.
 *
 * Running after `pracht:client-module-transform` (both are `post`; array order
 * decides) is deliberate: prefresh sees the stripped module, whose exports are
 * only components, rather than the authored one where a co-located `loader`
 * would stop it self-accepting anyway.
 */
export function createClientModulePrefreshPlugin(preactPlugins: PluginOption[]): Plugin | null {
  const transform = resolvePrefreshTransform(preactPlugins);
  if (!transform) return null;

  return {
    name: "pracht:client-module-prefresh",
    enforce: "post",
    // Prefresh no-ops during build through its own `shouldSkip`, but a
    // production bundle has no business carrying a refresh runtime even by
    // accident.
    apply: "serve",
    async transform(code, id, options) {
      if (options?.ssr) return null;
      if (!isPrachtClientModuleId(id)) return null;

      // The stripped id is what prefresh's own filter accepts, and it is also
      // the id it embeds in component registrations — so a route registers
      // under its real file path rather than a query-suffixed variant.
      return await transform.call(this, code, stripPrachtClientModuleQuery(id), options);
    },
  };
}

type TransformHandler = NonNullable<Extract<Plugin["transform"], (...args: never[]) => unknown>>;

/**
 * `@preact/preset-vite` returns a plugin array whose shape is its own business;
 * find prefresh by name rather than by position, and treat its absence as "no
 * Fast Refresh configured" rather than an error.
 */
function resolvePrefreshTransform(preactPlugins: PluginOption[]): TransformHandler | null {
  for (const plugin of flattenPlugins(preactPlugins)) {
    if (plugin.name !== "prefresh") continue;
    const transform = plugin.transform;
    if (typeof transform === "function") return transform as TransformHandler;
    // Vite also accepts the object form `{ filter, handler }`.
    if (transform && typeof transform === "object" && "handler" in transform) {
      return transform.handler as TransformHandler;
    }
  }
  return null;
}

function flattenPlugins(plugins: PluginOption[]): Plugin[] {
  const flat: Plugin[] = [];
  const visit = (option: PluginOption): void => {
    if (!option || typeof (option as { then?: unknown }).then === "function") return;
    if (Array.isArray(option)) {
      for (const nested of option) visit(nested as PluginOption);
      return;
    }
    if (typeof option === "object" && "name" in option) flat.push(option as Plugin);
  };
  for (const plugin of plugins) visit(plugin);
  return flat;
}
