/**
 * Emits `/search-index.json`, the index the header search box (`src/islands/DocsSearch.tsx`)
 * fetches the first time it opens.
 *
 * One entry per page section, built from the same content collection and the
 * same section split as the docs MCP index (`docs-index-build.ts`), so a
 * search result's `#anchor` always exists on the rendered page.
 */

import type { Plugin } from "vite";

import { buildDocsIndexData, type DocsIndexSourceDocument } from "./docs-index-build.ts";
import { NAV_PAGES } from "./src/nav.ts";
import { plainText } from "./src/server/docs-text.ts";

export interface SearchIndex {
  /** `[path, title, section label]` */
  pages: [string, string, string][];
  /**
   * `[page, anchor, heading, text]`; anchor `""` is the page introduction.
   * `text` is the whole section, so every identifier in it is searchable
   * (about 140 KB gzipped, fetched the first time search opens).
   */
  entries: [number, string, string, string][];
}

export function buildSearchIndex(documents: readonly DocsIndexSourceDocument[]): SearchIndex {
  const data = buildDocsIndexData(documents);
  const sectionOf = new Map(NAV_PAGES.map((page) => [page.href, page.section]));
  const pages = data.pages.map((page): [string, string, string] => [
    page.path,
    page.title,
    sectionOf.get(page.path) ?? "",
  ]);
  const entries = data.sections.map(
    ([page, anchor, heading, , , , ownStart, ownEnd]): [number, string, string, string] => {
      const { body, lead } = data.pages[page];
      const own = plainText(body.slice(ownStart, ownEnd));
      const text = anchor === "" ? `${plainText(lead)} ${own}`.trim() : own;
      return [page, anchor, heading, text];
    },
  );
  return { pages, entries };
}

export function searchIndex({
  collection,
}: {
  collection: { all(): Promise<readonly DocsIndexSourceDocument[]> };
}): Plugin {
  const generate = async () => JSON.stringify(buildSearchIndex(await collection.all()));
  return {
    name: "pracht-docs:search-index",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },
    configureServer(server) {
      server.middlewares.use("/search-index.json", (_req, res, next) => {
        generate().then((json) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(json);
        }, next);
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "search-index.json", source: await generate() });
    },
  };
}
