/**
 * Emits the docs MCP index as the server-only module `virtual:docs-mcp-index`.
 *
 * The index is built from the same content collection that renders the pages
 * (see docs-index-build.ts), once per build, so the Worker parses
 * one compact JSON document on its first tool call instead of every page's
 * compiled HTML. Importing it from client code fails the build.
 */

import type { Plugin } from "vite";

import { buildDocsIndexData, type DocsIndexSourceDocument } from "./docs-index-build.ts";

export const DOCS_INDEX_MODULE = "virtual:docs-mcp-index";
const RESOLVED = `\0${DOCS_INDEX_MODULE}`;

export interface DocsIndexPluginOptions {
  collection: {
    root: string;
    all(): Promise<readonly DocsIndexSourceDocument[]>;
  };
}

/** The module source the plugin serves; exported for tests. */
export async function docsIndexModuleSource(
  collection: DocsIndexPluginOptions["collection"],
): Promise<string> {
  const data = buildDocsIndexData(await collection.all());
  // A JSON string literal parses faster than the equivalent object literal.
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(data))});\n`;
}

export function docsIndex({ collection }: DocsIndexPluginOptions): Plugin {
  return {
    name: "pracht-docs:mcp-index",
    resolveId(id) {
      return id === DOCS_INDEX_MODULE ? RESOLVED : null;
    },
    async load(id, options) {
      if (id !== RESOLVED) return null;
      const consumer = this.environment?.config?.consumer;
      if (consumer === "client" || (!consumer && options?.ssr === false)) {
        throw new Error(`${DOCS_INDEX_MODULE} is server-only; import it from a capability.`);
      }
      return docsIndexModuleSource(collection);
    },
    configureServer(server) {
      // Rebuild the index after a docs page changes in dev.
      const invalidate = (file: string) => {
        if (!file.startsWith(collection.root) || !/\.mdx?$/.test(file)) return;
        for (const environment of Object.values(server.environments)) {
          const module = environment.moduleGraph.getModuleById(RESOLVED);
          if (module) environment.moduleGraph.invalidateModule(module);
        }
      };
      server.watcher.on("change", invalidate).on("add", invalidate).on("unlink", invalidate);
    },
  };
}
