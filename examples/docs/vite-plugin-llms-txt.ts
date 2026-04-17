/**
 * Vite plugin that emits `/llms.txt` and `/llms-full.txt`
 * (https://llmstxt.org). Both files give LLM agents a curated view of the
 * site: `llms.txt` is a summary plus link list, `llms-full.txt` inlines the
 * full markdown source of every listed page.
 *
 * Reads route → file mappings by scanning the manifest as text (same
 * rationale as vite-plugin-sitemap.ts) and pulls title/lead from each .md
 * file's frontmatter.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

export interface LlmsTxtSection {
  // Section heading, rendered as `## <heading>` in llms.txt.
  heading: string;
  // Path prefix that routes must match to be included (e.g. `/docs`).
  match: string;
  // Mark this section as `## Optional` per the llmstxt.org convention.
  optional?: boolean;
}

export interface LlmsTxtPluginOptions {
  origin: string;
  routesFile: string;
  title: string;
  description: string;
  // Optional paragraphs shown between the blockquote and the first section.
  details?: string[];
  sections: LlmsTxtSection[];
}

interface RouteEntry {
  path: string;
  file: string;
}

interface DocEntry extends RouteEntry {
  title: string;
  lead?: string;
  body: string;
}

function extractRoutes(source: string): RouteEntry[] {
  // `route("/path", () => import("./file"), …)` or `route("/path", "./file", …)`.
  const pattern =
    /\broute\s*\(\s*(["'])([^"']+)\1\s*,\s*(?:\(\s*\)\s*=>\s*import\s*\(\s*(["'])([^"']+)\3\s*\)|(["'])([^"']+)\5)/g;
  const out: RouteEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const path = match[2];
    const file = match[4] ?? match[6];
    if (!path.startsWith("/") || !file) continue;
    if (path.includes(":") || path.includes("*")) continue;
    out.push({ path, file });
  }
  return out;
}

interface Frontmatter {
  title?: string;
  lead?: string;
}

function parseMd(source: string): { fm: Frontmatter; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { fm: {}, body: source };

  const fm: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].replace(/^["']|["']$/g, "").trim();
    if (key === "title" || key === "lead") fm[key] = value;
  }
  return { fm, body: match[2] };
}

function loadDocs(routesFile: string): DocEntry[] {
  const source = readFileSync(routesFile, "utf-8");
  const baseDir = dirname(routesFile);
  const docs: DocEntry[] = [];
  for (const route of extractRoutes(source)) {
    if (!route.file.endsWith(".md")) continue;
    const absolute = resolve(baseDir, route.file);
    let raw: string;
    try {
      raw = readFileSync(absolute, "utf-8");
    } catch {
      continue;
    }
    const { fm, body } = parseMd(raw);
    docs.push({
      ...route,
      title: fm.title ?? route.path,
      lead: fm.lead,
      body: body.trim(),
    });
  }
  return docs;
}

function buildLlmsTxt(options: LlmsTxtPluginOptions, docs: DocEntry[]): string {
  const origin = options.origin.replace(/\/$/, "");
  const parts: string[] = [];
  parts.push(`# ${options.title}`, "", `> ${options.description}`);
  if (options.details?.length) {
    parts.push("");
    for (const p of options.details) parts.push(p);
  }

  for (const section of options.sections) {
    const prefix = section.match.replace(/\/$/, "");
    const matched = docs.filter((doc) => doc.path === prefix || doc.path.startsWith(`${prefix}/`));
    if (!matched.length) continue;
    matched.sort((a, b) => a.path.localeCompare(b.path));
    parts.push("", section.optional ? `## Optional` : `## ${section.heading}`, "");
    for (const doc of matched) {
      const url = `${origin}${doc.path}`;
      const lead = doc.lead ? `: ${doc.lead}` : "";
      parts.push(`- [${doc.title}](${url})${lead}`);
    }
  }

  return parts.join("\n") + "\n";
}

function buildLlmsFull(options: LlmsTxtPluginOptions, docs: DocEntry[]): string {
  const parts: string[] = [];
  parts.push(`# ${options.title}`, "", `> ${options.description}`, "");

  for (const section of options.sections) {
    const prefix = section.match.replace(/\/$/, "");
    const matched = docs.filter((doc) => doc.path === prefix || doc.path.startsWith(`${prefix}/`));
    matched.sort((a, b) => a.path.localeCompare(b.path));
    for (const doc of matched) {
      parts.push(`---`, ``, `# ${doc.title}`, ``);
      if (doc.lead) parts.push(`> ${doc.lead}`, ``);
      parts.push(doc.body, ``);
    }
  }

  return parts.join("\n") + "\n";
}

export function llmsTxt(options: LlmsTxtPluginOptions): Plugin {
  const generate = () => {
    const docs = loadDocs(options.routesFile);
    return {
      summary: buildLlmsTxt(options, docs),
      full: buildLlmsFull(options, docs),
    };
  };

  return {
    name: "pracht-llms-txt",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/llms.txt" && req.url !== "/llms-full.txt") return next();
        const { summary, full } = generate();
        res.setHeader("content-type", "text/markdown; charset=utf-8");
        res.end(req.url === "/llms.txt" ? summary : full);
      });
    },
    generateBundle() {
      const { summary, full } = generate();
      this.emitFile({ type: "asset", fileName: "llms.txt", source: summary });
      this.emitFile({ type: "asset", fileName: "llms-full.txt", source: full });
    },
  };
}
