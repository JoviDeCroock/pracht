// The header search ranks against /search-index.json. Every identifier a page
// documents must be in it. Anchors come from the same section split as the docs
// MCP index, which docs-mcp.test.ts checks against the rendered headings.
import { describe, expect, it } from "vitest";

import { docsContent } from "../content";
import { buildSearchIndex } from "../vite-plugin-search-index";

describe("search index", async () => {
  const documents = await docsContent.all();
  const index = buildSearchIndex(documents);
  const text = (path: string) =>
    index.entries
      .filter(([page]) => index.pages[page][0] === path)
      .map(([, , , body]) => body)
      .join(" ");

  it("keeps identifiers from deep inside long sections", () => {
    expect(text("/docs/recipes/tanstack-query")).toContain("useQuery");
    expect(text("/docs/recipes/auth")).toContain("SessionStore");
  });

  it("labels every page with its sidebar section", () => {
    for (const [path, , section] of index.pages) expect(section, path).not.toBe("");
  });
});
