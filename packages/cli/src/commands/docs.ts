import { defineCommand } from "citty";

import { VERSION } from "../constants.js";
import {
  defaultDocsDir,
  extractDocsSection,
  loadDocsIndex,
  matchDocsTopic,
  readDocsPage,
  searchDocs,
  type DocsIndex,
  type DocsSearchHit,
} from "../docs.js";

const LEAD_WIDTH = 110;

export interface DocsCommandInput {
  /** Positional words; joined with spaces into one topic. */
  topic: string[];
  /** `--search` value: `undefined` when absent, `""` when given without a value. */
  search?: string;
  json?: boolean;
}

export interface DocsCommandResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

/**
 * `pracht docs` without the process: returns what to print, so it can be
 * exercised against a fixture docs directory.
 */
export function runDocsCommand(
  input: DocsCommandInput,
  { dir = defaultDocsDir(), version = VERSION }: { dir?: string; version?: string } = {},
): DocsCommandResult {
  const json = Boolean(input.json);
  const topic = input.topic.join(" ").trim();

  try {
    if (input.search !== undefined) {
      if (topic !== "") {
        throw new Error(
          `Pass a topic or --search, not both. Quote a multi-word query: pracht docs --search "${[input.search, topic].join(" ").trim()}".`,
        );
      }
      const query = input.search.trim();
      return ok(formatSearch(query, searchDocs(query, { dir }), json));
    }

    const index = loadDocsIndex(dir);
    if (topic === "") return ok(formatList(index, version, json));

    const match = matchDocsTopic(index, topic);
    if (!match.ok) throw new Error(match.message);
    let markdown = readDocsPage(match.page, dir);
    let anchor: string | null = null;
    if (match.anchor) {
      const section = extractDocsSection(markdown, match.anchor);
      if (!section.ok) throw new Error(`${match.page.slug}: ${section.message}`);
      markdown = section.markdown;
      anchor = section.anchor;
    }

    if (json) {
      return ok(
        JSON.stringify(
          {
            slug: match.page.slug,
            title: match.page.title,
            url: anchor ? `${match.page.url}#${anchor}` : match.page.url,
            section: anchor,
            markdown,
          },
          null,
          2,
        ),
      );
    }
    return ok(markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json
      ? {
          exitCode: 1,
          stdout: `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
          stderr: "",
        }
      : { exitCode: 1, stdout: "", stderr: `${message}\n` };
  }
}

function ok(text: string): DocsCommandResult {
  return { exitCode: 0, stdout: text.endsWith("\n") ? text : `${text}\n`, stderr: "" };
}

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
    // citty binds the first positional to `topic`; all of them arrive in `_`,
    // so `pracht docs view transitions` works unquoted.
    const result = runDocsCommand({
      topic: (args._ ?? []).map(String).filter((value) => value !== ""),
      search:
        args.search === undefined ? undefined : typeof args.search === "string" ? args.search : "",
      json: Boolean(args.json),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  },
});

function formatList(index: DocsIndex, version: string, json: boolean): string {
  if (json) {
    return JSON.stringify({ version, site: index.site, pages: index.pages }, null, 2);
  }

  const width = Math.max(...index.pages.map((page) => page.slug.length), 4);
  const lines = [
    `pracht docs for @pracht/cli ${version} — ${index.pages.length} pages.`,
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
  return lines.join("\n");
}

function formatSearch(query: string, hits: DocsSearchHit[], json: boolean): string {
  if (json) return JSON.stringify({ query, results: hits }, null, 2);
  if (hits.length === 0) {
    return `No docs match "${query}". Run \`pracht docs\` to list every page.`;
  }
  const lines: string[] = [];
  for (const hit of hits) {
    const target = hit.anchor ? `${hit.slug}#${hit.anchor}` : hit.slug;
    const where = hit.heading === hit.title ? hit.title : `${hit.title} › ${hit.heading}`;
    lines.push(`${target}  (${where})`, `  ${hit.snippet}`, "");
  }
  lines.push("Read a result with `pracht docs <slug>#<section>`.");
  return lines.join("\n");
}

function clip(text: string): string {
  return text.length <= LEAD_WIDTH ? text : `${text.slice(0, LEAD_WIDTH - 1).trimEnd()}…`;
}
