import type { RenderMode } from "@pracht/core";
import { createDefaultNodeAdapter, type PrachtAdapter } from "./plugin-adapter.ts";

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
}

export type ResolvedPrachtPluginOptions = Required<PrachtPluginOptions>;

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
};

export function resolveOptions(options: PrachtPluginOptions): ResolvedPrachtPluginOptions {
  return {
    ...DEFAULTS,
    ...options,
  };
}
