import type { RenderMode } from "@pracht/core";
import { createDefaultNodeAdapter, type PrachtAdapter } from "./plugin-adapter.ts";

export interface TsrxOptions {
  jsxImportSource?: string;
  suspenseSource?: string;
}

export interface PrachtPluginOptions {
  appFile?: string;
  routesDir?: string;
  shellsDir?: string;
  middlewareDir?: string;
  apiDir?: string;
  serverDir?: string;
  adapter?: PrachtAdapter;
  /** Enable file-system pages routing by pointing to the pages directory (e.g. "/src/pages"). */
  pagesDir?: string;
  /** Default render mode for pages when RENDER_MODE is not exported. Defaults to "ssr". */
  pagesDefaultRender?: RenderMode;
  /** Maximum number of SSG/ISG pages rendered concurrently during `pracht build`. */
  prerenderConcurrency?: number;
  /**
   * Enable `.tsrx` (TSRX/Ripple-flavoured Preact) modules. Set to `true` to use defaults,
   * or pass an options object forwarded to `@tsrx/vite-plugin-preact`. Requires the
   * `@tsrx/vite-plugin-preact` package to be installed.
   */
  tsrx?: boolean | TsrxOptions;
}

export type ResolvedPrachtPluginOptions = Required<Omit<PrachtPluginOptions, "tsrx">> & {
  tsrx: false | TsrxOptions;
};

const DEFAULTS: ResolvedPrachtPluginOptions = {
  appFile: "/src/routes.ts",
  middlewareDir: "/src/middleware",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  apiDir: "/src/api",
  serverDir: "/src/server",
  adapter: createDefaultNodeAdapter(),
  pagesDir: "",
  pagesDefaultRender: "ssr",
  prerenderConcurrency: 10,
  tsrx: false,
};

export function resolveOptions(options: PrachtPluginOptions): ResolvedPrachtPluginOptions {
  const tsrx: false | TsrxOptions =
    options.tsrx === true
      ? {}
      : options.tsrx === false || options.tsrx == null
        ? false
        : options.tsrx;

  const resolved = {
    ...DEFAULTS,
    ...options,
    tsrx,
  };
  if (!Number.isInteger(resolved.prerenderConcurrency) || resolved.prerenderConcurrency <= 0) {
    throw new Error("pracht({ prerenderConcurrency }) expects a positive integer.");
  }
  return resolved;
}
