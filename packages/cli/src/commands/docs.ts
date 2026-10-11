import { defineCommand } from "citty";

import { VERSION } from "../constants.js";
import {
  extractDocsSection,
  loadDocsIndex,
  matchDocsTopic,
  readDocsPage,
  searchDocs,
  type DocsIndex,
  type DocsSearchHit,
} from "../docs.js";

const LEAD_WIDTH = 110;

export default defineCommand({
  meta: {
    name: "docs",
    description: "Read the pracht docs for the installed version, offline",
  },
  args: {
    topic: {
      type: "positional",
      description: "Page slug or title, optionally with #section (omit to list pages)",
      required: false,
    },
    search: {
      type: "string",
      description: "Keyword search over every page's headings, prose, and code",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  run({ args }) {
    const json = Boolean(args.json);
    // citty binds the first positional to `topic`; the rest arrive in `_`, so
    // `pracht docs view transitions` and `--search data loading` both work.
    const positionals = (args._ ?? []).map(String).filter((value) => value !== "");

    try {
      if (args.search !== undefined) {
        const query = [typeof args.search === "string" ? args.search : "", ...positionals]
          .join(" ")
          .trim();
        printSearch(query, searchDocs(query), json);
        return;
      }

      const index = loadDocsIndex();
      const topic = positionals.join(" ").trim();
      if (topic === "") {
        printList(index, json);
        return;
      }

      const match = matchDocsTopic(index, topic);
      if (!match.ok) throw new Error(match.message);
      let markdown = readDocsPage(match.page);
      if (match.anchor) {
        const section = extractDocsSection(markdown, match.anchor);
        if (!section.ok) throw new Error(`${match.page.slug}: ${section.message}`);
        markdown = section.markdown;
      }

      if (json) {
        console.log(
          JSON.stringify(
            {
              slug: match.page.slug,
              title: match.page.title,
              url: match.anchor ? `${match.page.url}#${match.anchor}` : match.page.url,
              section: match.anchor || null,
              markdown,
            },
            null,
            2,
          ),
        );
      } else {
        process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      else console.error(message);
      process.exit(1);
    }
  },
});

function printList(index: DocsIndex, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({ version: VERSION, site: index.site, pages: index.pages }, null, 2),
    );
    return;
  }

  const width = Math.max(...index.pages.map((page) => page.slug.length), 4);
  const lines = [
    `pracht docs for @pracht/cli ${VERSION} — ${index.pages.length} pages.`,
    "Read one with `pracht docs <slug>` (or `<slug>#<section>`); search with `pracht docs --search <query>`.",
  ];
  let section: string | null = null;
  for (const page of index.pages) {
    if (page.section !== section) {
      section = page.section;
      lines.push("", section);
    }
    lines.push(
      `  ${page.slug.padEnd(width)}  ${page.title}${page.lead ? ` — ${clip(page.lead)}` : ""}`,
    );
  }
  console.log(lines.join("\n"));
}

function printSearch(query: string, hits: DocsSearchHit[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ query, results: hits }, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(`No docs match "${query}". Run \`pracht docs\` to list every page.`);
    return;
  }
  const lines: string[] = [];
  for (const hit of hits) {
    const target = hit.anchor ? `${hit.slug}#${hit.anchor}` : hit.slug;
    const where = hit.heading === hit.title ? hit.title : `${hit.title} › ${hit.heading}`;
    lines.push(`${target}  (${where})`, `  ${hit.snippet}`, "");
  }
  lines.push("Read a result with `pracht docs <slug>#<section>`.");
  console.log(lines.join("\n"));
}

function clip(text: string): string {
  return text.length <= LEAD_WIDTH ? text : `${text.slice(0, LEAD_WIDTH - 1).trimEnd()}…`;
}
