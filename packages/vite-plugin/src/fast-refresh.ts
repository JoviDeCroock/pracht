import { transformWithOxc, type Plugin, type PluginOption, type ResolvedConfig } from "vite";

import {
  isPrachtClientModuleId,
  isPrefreshCompatibleId,
  toPrachtClientPrefreshId,
} from "./client-module-query.ts";

interface FastRefreshOptions {
  isRouteOrShellModule?: (id: string) => boolean;
  /** The `@prefresh/vite` plugins to take the stages from. Tests substitute their own. */
  loadStagePlugins?: () => PluginOption | Promise<PluginOption>;
}

/**
 * Preact Fast Refresh for every module the browser runs.
 *
 * A module is refreshed in three stages:
 *
 * 1. `prefresh-rolldown` keeps each `createContext()` on a stable key, so a
 *    provider and its consumers still share one context after an update.
 * 2. Oxc's refresh transform registers the module's components and signs its
 *    hooks (`$RefreshReg$` / `$RefreshSig$`).
 * 3. `prefresh-wrapper` binds those registrations to the module id and makes
 *    the module accept its own update.
 *
 * `@prefresh/vite` ships stages 1 and 3 as Vite plugins and leaves stage 2 to
 * Vite's own Oxc pass. Pracht takes the two stages as functions and runs all
 * three here instead, for two reasons.
 *
 * Vite's Oxc pass registers only a file that is JSX or imports the JSX
 * runtime. A custom hook in `useCart.ts` or a component written with `h()`
 * would go unsigned, and an edit that reorders its hooks would then keep the
 * old state under the new hook order. Registering every script module here
 * signs those too.
 *
 * And all of `@prefresh/vite`'s plugins gate on an id that ends in a script
 * extension, so an id carrying a query never matches. Pracht loads route and
 * shell modules in the browser through
 * `import.meta.glob(..., { query: "?pracht-client" })` so its post transform
 * can strip server-only exports, which means the module the browser actually
 * runs is `/src/routes/home.tsx?pracht-client`. Left alone it gets no
 * registration and no `import.meta.hot.accept`, and with no self-accepting
 * boundary the update propagates to the non-accepting virtual client entry:
 * every edit to a route or a shell becomes a full page reload with client
 * state loss.
 *
 * Running after `pracht:client-module-transform` (both are `post`; array order
 * decides) is deliberate: the stages see a route module stripped, with only
 * components for exports, rather than the authored one.
 *
 * A route or shell module is handed to the stages under a synthetic id — see
 * `toPrachtClientPrefreshId`. It must satisfy prefresh's extension filter
 * *and* stay distinct from the id of the authored file, because the same file
 * can be in the client graph twice and the id doubles as prefresh's component
 * registration key.
 *
 * `@prefresh/vite` is imported on the first module that needs it, so a build
 * never loads it, and none of its plugins is registered with Vite: its Babel
 * fallback never runs and nothing is rewritten for SSR.
 */
export function createFastRefreshPlugin(options: FastRefreshOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  let disabled = false;
  let stages: Promise<PrefreshStages | null> | undefined;

  return {
    name: "pracht:fast-refresh",
    enforce: "post",
    // A production bundle has no business carrying a refresh runtime.
    apply: "serve",
    configResolved(resolved) {
      config = resolved;
      // Decided from the resolved config, where a plugin that turned HMR off in
      // its own `config` hook has already had its say. Without the HMR client
      // nothing defines `$RefreshReg$`, so no module may call it. A dev server
      // in production mode is skipped whole as well: the context stage turns
      // itself off there, and a module refreshed without it would detach its
      // consumers from their provider.
      disabled = resolved.server?.hmr === false || resolved.isProduction === true;
    },
    async transform(code, id, transformOptions) {
      if (disabled || transformOptions?.ssr) return null;
      // Absent when a test calls the hook without a plugin context.
      const environment = this.environment as typeof this.environment | undefined;
      if (environment?.config.consumer === "server") return null;

      const refreshId = resolveRefreshId(id, options);
      if (refreshId === null) return null;

      stages ??= loadPrefreshStages(options.loadStagePlugins ?? loadPrefreshVite, config);
      const resolved = await stages;
      if (!resolved) return null;

      let current = code;
      let map: object | undefined;

      if (resolved.context && current.includes("createContext")) {
        const memoized = readTransformResult(
          await resolved.context.call(this, current, refreshId, transformOptions),
        );
        if (memoized) {
          current = memoized.code;
          map = memoized.map;
        }
      }

      let registered;
      try {
        registered = await transformWithOxc(
          current,
          refreshId,
          {
            // The module is compiled JavaScript by now, whatever it was authored
            // in; `jsx` also accepts a compiled format that left JSX behind.
            lang: "jsx",
            sourcemap: true,
            jsx: { ...resolveJsxOptions(environment?.config.oxc ?? config?.oxc), refresh: true },
          },
          // Carries the context stage's map through, so the result still maps
          // back to the code this plugin was given.
          map,
        );
      } catch {
        // A module Vite can serve stays served. One this pass cannot parse
        // goes without Fast Refresh and reloads the page when edited.
        return current === code ? null : { code: current, map: (map ?? null) as never };
      }

      // Counted against the input rather than matched: a module can mention
      // `$RefreshReg$(` in a string without declaring a single component.
      if (countRefreshCalls(registered.code) <= countRefreshCalls(current)) {
        return current === code ? null : { code: current, map: (map ?? null) as never };
      }

      const wrapped = readTransformResult(
        await resolved.wrapper.call(this, registered.code, refreshId, transformOptions),
      );
      // Registrations with nothing to define `$RefreshReg$` would throw in the
      // browser, so a module the wrapper declined keeps its unregistered code.
      if (!wrapped) return current === code ? null : { code: current, map: (map ?? null) as never };

      // The wrapper only prefixes the first line and appends after the last,
      // so the registration pass's map still points every line at its source.
      return { code: wrapped.code, map: registered.map as never };
    },
  };
}

async function loadPrefreshVite(): Promise<PluginOption> {
  const { default: prefresh } = await import("@prefresh/vite");
  return prefresh();
}

/**
 * The id to refresh a module under, or `null` for a module to leave alone.
 * The plain-module rule is the one `@prefresh/vite` applies: a script
 * extension with nothing after it, outside `node_modules`.
 */
function resolveRefreshId(id: string, options: FastRefreshOptions): string | null {
  // Prefresh's filter rejects ids carrying a query and compiled route formats
  // such as `.mdx` or `.tsrx`; the id it is given is also the key it embeds in
  // component registrations. Both copies of a file that reaches the browser
  // twice — through the route glob and through a plain import from a sibling
  // route — must therefore keep *distinct* keys, or prefresh queues a
  // component replacement no edit asked for. `toPrachtClientPrefreshId`
  // satisfies the filter by keeping the extension last and preserves the
  // distinction by moving the marker into the basename.
  if (isPrachtClientModuleId(id)) return toPrachtClientPrefreshId(id);
  if (isPrefreshCompatibleId(id)) return id.includes("node_modules") ? null : id;
  if (options.isRouteOrShellModule?.(id) === true) return toPrachtClientPrefreshId(id);
  return null;
}

const REFRESH_CALL_RE = /\$Refresh(?:Reg|Sig)\$\(/g;

function countRefreshCalls(code: string): number {
  return code.match(REFRESH_CALL_RE)?.length ?? 0;
}

type TransformHandler = NonNullable<Extract<Plugin["transform"], (...args: never[]) => unknown>>;

interface PrefreshStages {
  context: TransformHandler | null;
  wrapper: TransformHandler;
}

/**
 * Find the stages by plugin name rather than by position, and treat a missing
 * wrapper as "no Fast Refresh available" rather than an error. The plugins are
 * never registered with Vite, so the resolved config they would have been
 * handed is passed on here: the context stage enables itself from it.
 */
async function loadPrefreshStages(
  load: () => PluginOption | Promise<PluginOption>,
  config: ResolvedConfig | undefined,
): Promise<PrefreshStages | null> {
  try {
    const plugins = await flattenPlugins(load());
    const wrapperPlugin = plugins.find((plugin) => plugin.name === "prefresh-wrapper");
    const wrapper = resolveTransform(wrapperPlugin);
    if (!wrapper) return null;
    const contextPlugin = plugins.find((plugin) => plugin.name === "prefresh-rolldown");
    if (config) {
      for (const plugin of [wrapperPlugin, contextPlugin]) {
        const hook = plugin?.configResolved;
        const handler = typeof hook === "function" ? hook : hook?.handler;
        await (handler as ((config: ResolvedConfig) => unknown) | undefined)?.call(plugin, config);
      }
    }
    return { context: resolveTransform(contextPlugin), wrapper };
  } catch (error) {
    config?.logger.warn(
      `[pracht] Fast Refresh is unavailable, so component edits reload the page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function flattenPlugins(option: PluginOption | Promise<PluginOption>): Promise<Plugin[]> {
  const resolved = await option;
  if (!resolved) return [];
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map((entry) => flattenPlugins(entry)));
    return nested.flat();
  }
  return [resolved as Plugin];
}

function resolveTransform(plugin: Plugin | undefined): TransformHandler | null {
  const transform = plugin?.transform;
  if (typeof transform === "function") return transform as TransformHandler;
  // Vite also accepts the object form `{ filter, handler }`.
  if (transform && typeof transform === "object" && "handler" in transform) {
    return transform.handler as TransformHandler;
  }
  return null;
}

function readTransformResult(result: unknown): { code: string; map: object | undefined } | null {
  if (typeof result === "string") return { code: result, map: undefined };
  if (!result || typeof result !== "object" || !("code" in result)) return null;
  const { code, map } = result as { code?: unknown; map?: unknown };
  if (typeof code !== "string") return null;
  if (typeof map === "string") return { code, map: JSON.parse(map) as object };
  return { code, map: map && typeof map === "object" ? { ...map } : undefined };
}

/** The app's resolved JSX options, so registration compiles what the app compiles. */
function resolveJsxOptions(oxc: unknown): Record<string, unknown> {
  const jsx = oxc && typeof oxc === "object" ? (oxc as { jsx?: unknown }).jsx : undefined;
  if (jsx && typeof jsx === "object") return jsx as Record<string, unknown>;
  return { runtime: "automatic", importSource: "preact" };
}
