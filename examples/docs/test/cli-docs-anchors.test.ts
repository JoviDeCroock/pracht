// `pracht docs <slug>#<anchor>` and the bundled pages' cross-links use the
// heading ids this site renders. The site derives them from marked's HTML; the
// CLI derives them from Markdown. Render every page here with marked and the
// site's own slugify, and require the CLI to agree on every heading.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Marked, Renderer, type Tokens } from "marked";
import { describe, expect, it } from "vitest";

import { docsPageAnchors } from "../../../packages/cli/src/docs.ts";
import { slugify } from "../src/utils/heading-slug.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/routes/docs");

/** The ids the site renders, mirroring `createRenderer()` in content.ts. */
function siteAnchors(markdown: string): string[] {
  const ids: string[] = [];
  const used = new Map<string, number>();
  const renderer = new Renderer();
  renderer.heading = function ({ tokens }: Tokens.Heading) {
    const base = slugify(this.parser.parseInline(tokens)) || `section-${used.size + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    ids.push(seen === 0 ? base : `${base}-${seen}`);
    return "";
  };
  new Marked({ renderer }).parse(markdown);
  return ids;
}

describe("pracht docs heading anchors", () => {
  const pages = readdirSync(docsDir).filter((file) => file.endsWith(".md"));

  it.each(pages)("%s matches the site's heading ids", (file) => {
    const body = readFileSync(resolve(docsDir, file), "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(docsPageAnchors(body)).toEqual(siteAnchors(body));
  });
});
