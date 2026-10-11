/**
 * Build-time half of the docs MCP index.
 *
 * `vite-plugin-docs-index.ts` runs this over the `docs` content collection —
 * the registry that compiles the pages and generates `llms.txt` — and emits
 * the result as a server-only virtual module. The Worker therefore loads one
 * compact JSON document instead of every page's compiled HTML, and never
 * tokenizes the corpus at request time.
 *
 * Section anchors are read from the compiled HTML, not re-derived from the
 * Markdown, so every `section` the tools return is exactly a `#fragment` the
 * rendered page carries. A page whose headings and compiled ids disagree
 * fails the build.
 */

import type { DocsIndexData, DocsSectionTuple, SectionPosition } from "./src/server/docs-index.ts";
import { textStems } from "./src/server/docs-text.ts";

export interface DocsIndexSourceDocument {
  id: string;
  path: string;
  frontmatter: Readonly<Record<string, unknown>>;
  body?: string;
  compiled: unknown;
}

export function buildDocsIndexData(documents: readonly DocsIndexSourceDocument[]): DocsIndexData {
  const sorted = [...documents].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const pages: DocsIndexData["pages"] = [];
  const sections: DocsSectionTuple[] = [];
  const postings = new Map<string, number[]>();

  sorted.forEach((document, pageIndex) => {
    const body = typeof document.body === "string" ? document.body : "";
    const title = stringField(document.frontmatter.title) || document.path;
    const lead = stringField(document.frontmatter.lead);
    pages.push({ id: document.id, path: document.path, title, lead, body });

    const headings = markdownHeadings(body);
    const ids = compiledHeadingIds(document.compiled);
    if (ids.length !== headings.length) {
      throw new Error(
        `[docs-index] ${document.path}: ${headings.length} Markdown headings but ${ids.length} heading ids in the compiled page. ` +
          "A heading construct the index does not recognise would hand agents anchors that do not exist.",
      );
    }

    const firstOffset = headings.length ? headings[0].offset : body.length;
    const add = (tuple: SectionPosition, searchable: string) => {
      const counts = new Map<string, number>();
      let words = 0;
      for (const { stem } of textStems(searchable)) {
        counts.set(stem, (counts.get(stem) ?? 0) + 1);
        words++;
      }
      const sectionIndex = sections.push([...tuple, words]) - 1;
      for (const [stem, count] of counts) {
        let list = postings.get(stem);
        if (!list) postings.set(stem, (list = []));
        list.push(sectionIndex, count);
      }
    };

    // The introduction is searchable together with the page's one-line lead.
    add(
      [pageIndex, "", title, 1, 0, body.length, 0, firstOffset],
      `${lead}\n${body.slice(0, firstOffset)}`,
    );
    headings.forEach((heading, index) => {
      let end = body.length;
      for (let next = index + 1; next < headings.length; next++) {
        if (headings[next].depth <= heading.depth) {
          end = headings[next].offset;
          break;
        }
      }
      const ownEnd = index + 1 < headings.length ? headings[index + 1].offset : body.length;
      const lineEnd = body.indexOf("\n", heading.offset);
      const ownStart = lineEnd === -1 || lineEnd > ownEnd ? ownEnd : lineEnd + 1;
      add(
        [
          pageIndex,
          ids[index].id,
          ids[index].text,
          heading.depth,
          heading.offset,
          end,
          ownStart,
          ownEnd,
        ],
        body.slice(ownStart, ownEnd),
      );
    });
  });

  return { version: 1, pages, sections, postings: Object.fromEntries(postings) };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `<hN id="…">` ids in document order, from the HTML the page renders. */
export function compiledHeadingIds(compiled: unknown): { id: string; text: string }[] {
  const html =
    compiled &&
    typeof compiled === "object" &&
    typeof (compiled as { html?: unknown }).html === "string"
      ? (compiled as { html: string }).html
      : "";
  const headings: { id: string; text: string }[] = [];
  for (const match of html.matchAll(/<h[1-6] id="([^"]+)">([\s\S]*?)<\/h[1-6]>/g)) {
    headings.push({
      id: decodeEntities(match[1]),
      text: decodeEntities(match[2].replace(/<[^>]*>/g, "")).trim(),
    });
  }
  return headings;
}

interface MarkdownHeading {
  depth: number;
  offset: number;
}

/** ATX headings outside fenced code, with their offsets in `body`. */
export function markdownHeadings(body: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null;
      }
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+.*)?$/.exec(line);
      if (heading) headings.push({ depth: heading[1].length, offset });
    }
    offset += line.length + 1;
  }
  return headings;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
