import { createNodeServerEntryModule } from "@pracht/adapter-node";
import type { Plugin } from "vite";

/**
 * An adapter object that bridges pracht's platform-agnostic core to a specific
 * deployment target.  Built-in adapters are provided by `@pracht/adapter-node`,
 * `@pracht/adapter-cloudflare`, and `@pracht/adapter-vercel`.  You can also
 * supply a custom adapter that conforms to this interface.
 */
export interface PrachtAdapter {
  /** A short identifier used at build time (e.g. "node", "cloudflare", "vercel"). */
  id: string;
  /**
   * Extra import statements that must appear at the top of the generated
   * `virtual:pracht/server` module.  Return an empty string if none are needed.
   */
  serverImports: string;
  /**
   * Returns the JavaScript source code appended to the generated
   * `virtual:pracht/server` module.  This is where the adapter wires up its
   * request handler or default export.
   */
  createServerEntryModule(): string;
  /**
   * Additional Vite plugins the adapter needs (e.g. `@cloudflare/vite-plugin`).
   * Returned plugins are appended to the plugin array returned by `pracht()`.
   */
  vitePlugins?(): Plugin[];
  /**
   * If true, the adapter owns dev-server request handling and the vite-plugin
   * will not install its own SSR middleware. Used when the adapter contributes
   * a Vite plugin that runs the dev server in a platform-specific runtime
   * (e.g. Cloudflare workerd via `@cloudflare/vite-plugin`).
   */
  ownsDevServer?: boolean;
  /**
   * If true, the adapter targets an edge runtime that cannot resolve
   * dependencies from `node_modules` at runtime. The Vite plugin will set
   * `ssr.noExternal = true` for SSR builds so all dependencies are bundled
   * into the server output.
   */
  edge?: boolean;
}

export function createDefaultNodeAdapter(): PrachtAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createNodeServerEntryModule();
    },
  };
}
