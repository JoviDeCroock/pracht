// Keeps the public docs readable and their cross-links intact.
//
// The site pages grew from 18K to 82K words in four months, mostly one clause
// at a time: every hardening fix appended the guard it added to whichever
// paragraph described the feature, until single paragraphs ran to 3,000
// characters of edge cases no reader acts on. Two budgets stop that:
//
//   - **Blocks.** A paragraph or list item longer than `MAX_BLOCK_CHARS` is
//     almost always several ideas, or one idea plus its internals. Split it or
//     move the internals to `docs/`.
//   - **Pages.** Prose words outside code fences, capped at `MAX_PAGE_WORDS`.
//     A page listed in `PAGE_WORD_CEILINGS` may not grow past its entry; lower
//     the entry when the page shrinks, and delete it once the page fits.
//
// Every `/docs/…` link and `#anchor` must also resolve, so trimming a page
// cannot silently strand a link from another one.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, "..");
const docsDir = resolve(siteRoot, "src/routes/docs");

const MAX_BLOCK_CHARS = 600;
const MAX_PAGE_WORDS = 2_500;

/** Pages allowed over `MAX_PAGE_WORDS`, capped at their current size. */
const PAGE_WORD_CEILINGS: Record<string, number> = {
  // Local and remote capabilities on one page: WebMCP, MCP, and OAuth.
  "capabilities.md": 2_910,
};

const pages = readdirSync(docsDir)
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map((file) => ({ file, source: readFileSync(resolve(docsDir, file), "utf-8") }));

/** The URL `content.ts` publishes a page at. */
function routeFor(file: string): string {
  const id = file.replace(/\.md$/, "");
  for (const prefix of ["recipes", "migrate", "reference"]) {
    if (id.startsWith(`${prefix}-`)) return `/docs/${prefix}/${id.slice(prefix.length + 1)}`;
  }
  return `/docs/${id}`;
}

function stripFrontmatter(source: string): string {
  return source.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Every line, with frontmatter dropped and fenced code blanked out. */
function proseLines(source: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of stripFrontmatter(source).split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      lines.push("");
      continue;
    }
    lines.push(inFence ? "" : line);
  }
  return lines;
}

/** Paragraphs and individual list items; headings, tables, and comments are skipped. */
function blocks(source: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    current = [];
  };

  for (const line of proseLines(source)) {
    if (!line.trim() || /^\s*(?:#{1,6}\s|\||<!--)/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) flush();
    current.push(line.replace(/^\s*(?:>\s?)?(?:(?:[-*+]|\d+\.)\s+)?/, ""));
  }
  flush();
  return out;
}

function wordCount(source: string): number {
  return proseLines(source).join(" ").split(/\s+/).filter(Boolean).length;
}

/** The heading ids `content.ts` emits, in lockstep with its `slugify()`. */
function headingSlugs(source: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(source)) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    const base =
      heading[1]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/`/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .trim()
        .replace(/ /g, "-") || `section-${seen.size + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

/** `/docs/…` and `#…` link targets outside code. */
function internalLinks(source: string): string[] {
  const text = proseLines(source)
    .join("\n")
    .replace(/`[^`\n]*`/g, "");
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
    ...[...text.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
  ];
  return targets.filter((target) => target.startsWith("/docs") || target.startsWith("#"));
}

/** Bodies of fenced code blocks. */
function codeFences(source: string): string[] {
  return [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

describe("docs site content", () => {
  it(`keeps every paragraph and list item under ${MAX_BLOCK_CHARS} characters`, () => {
    const offenders = pages.flatMap(({ file, source }) =>
      blocks(source)
        .filter((block) => block.length > MAX_BLOCK_CHARS)
        .map((block) => `${file} (${block.length} chars): ${block.slice(0, 80)}…`),
    );
    expect(offenders).toEqual([]);
  });

  it(`keeps every page under ${MAX_PAGE_WORDS} words or its recorded ceiling`, () => {
    const offenders: string[] = [];
    for (const { file, source } of pages) {
      const words = wordCount(source);
      const ceiling = PAGE_WORD_CEILINGS[file];
      if (ceiling === undefined) {
        if (words > MAX_PAGE_WORDS) offenders.push(`${file}: ${words} words`);
      } else if (words > ceiling) {
        offenders.push(`${file}: ${words} words, ceiling ${ceiling}`);
      } else if (words <= MAX_PAGE_WORDS) {
        offenders.push(`${file}: fits the default budget; remove its ceiling`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every module augmentation inside a module", () => {
    // Without a top-level import or export the file is a global script, and
    // `declare module "@pracht/core"` replaces the package's types instead of
    // extending them.
    const offenders = pages.flatMap(({ file, source }) =>
      codeFences(source)
        .filter((code) => /^declare module ["']/m.test(code))
        .filter((code) => !/^(?:import|export)\s/m.test(code))
        .map((code) => `${file}: ${code.split("\n", 1)[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("resolves every internal link and anchor", () => {
    const byRoute = new Map(pages.map((page) => [routeFor(page.file), page]));
    const slugs = new Map(pages.map((page) => [page.file, headingSlugs(page.source)]));
    const broken: string[] = [];

    for (const page of pages) {
      for (const target of internalLinks(page.source)) {
        const [path, anchor] = target.split("#");
        const destination = path ? byRoute.get(path.replace(/\/$/, "")) : page;
        if (!destination) {
          if (path !== "/docs") broken.push(`${page.file}: ${target} (no such page)`);
          continue;
        }
        if (anchor && !slugs.get(destination.file)?.has(anchor)) {
          broken.push(`${page.file}: ${target} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
