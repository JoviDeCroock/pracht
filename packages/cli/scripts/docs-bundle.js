/**
 * Turns the public docs site pages (examples/docs/src/routes/docs/*.md) into
 * this package's `docs/<slug>.md`, plus `docs/index.json` and `docs/index.md`,
 * so `pracht docs` and the dev-mcp docs tools serve the pages that match the
 * installed CLI version, offline. `sync-docs.js` runs it during the package
 * build; it lives apart so tests can import it without running the copy.
 *
 * Site-internal links are rewritten so they still resolve without the site:
 * a link to another docs page becomes its sibling file (`routing.md#anchor`),
 * any other site path becomes an absolute https://pracht.resynapse.dev URL,
 * and a relative asset becomes its GitHub source URL.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const SITE_ORIGIN = "https://pracht.resynapse.dev";
const SOURCE_URL =
  "https://github.com/JoviDeCroock/pracht/blob/main/examples/docs/src/routes/docs/";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_SLUGS = new Set(["index"]);

/** The URL the docs site publishes a page at; mirrors `examples/docs/content.ts`. */
export function routeForSlug(slug) {
  for (const prefix of ["recipes", "migrate", "reference"]) {
    if (slug.startsWith(`${prefix}-`)) return `/docs/${prefix}/${slug.slice(prefix.length + 1)}`;
  }
  return `/docs/${slug}`;
}

/** Split `---` frontmatter from the body. Line endings must already be `\n`. */
export function splitFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields = {};
  for (const line of match[1].split("\n")) {
    // Only top-level scalar keys; nested blocks (`prev:`/`next:`) are indented.
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field || field[2] === "") continue;
    fields[field[1]] = parseScalar(field[2].trim());
  }
  return { fields, body: source.slice(match[0].length) };
}

function parseScalar(raw) {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

/** Nav sections and their page paths, in sidebar order, read from the docs shell. */
export function parseNavSections(shellSource) {
  const start = shellSource.indexOf("const NAV");
  if (start === -1) return [];
  const end = shellSource.indexOf("\n];", start);
  const nav = shellSource.slice(start, end === -1 ? undefined : end);
  const sections = [];
  for (const match of nav.matchAll(/label:\s*"([^"]+)"|href:\s*"([^"]+)"/g)) {
    if (match[1] !== undefined) sections.push({ label: match[1], paths: [] });
    else if (sections.length > 0) sections.at(-1).paths.push(match[2]);
  }
  return sections;
}

/**
 * Rewrite one Markdown link target so it is useful outside the site.
 * `pathToSlug` maps a published `/docs/...` path to its page slug.
 */
export function rewriteLinkTarget(target, pathToSlug) {
  if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return target;
  }
  if (target.startsWith("/")) {
    const hashIndex = target.indexOf("#");
    const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? "" : target.slice(hashIndex);
    const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const slug = pathToSlug.get(normalized);
    if (slug) return `${slug}.md${anchor}`;
    return `${SITE_ORIGIN}${target}`;
  }
  // A relative target: a sibling page keeps working as-is; anything else (an
  // image next to the page) is not shipped, so point at its source on GitHub.
  const bare = target.replace(/^\.\//, "");
  const file = bare.split("#")[0];
  if (/^[a-z0-9-]+\.md$/.test(file) && pathToSlug.has(routeForSlug(file.slice(0, -3)))) {
    return bare;
  }
  return `${SOURCE_URL}${bare}`;
}

/** Rewrite links in prose, leaving fenced code blocks and inline code spans untouched. */
export function rewriteLinks(body, pathToSlug) {
  let fence = null;
  return body
    .split("\n")
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1][0];
        else if (fenceMatch[1][0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;

      const definition = /^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
      if (definition) {
        return `${definition[1]}${rewriteLinkTarget(definition[2], pathToSlug)}${definition[3]}`;
      }

      return line
        .split(/(`[^`\n]*`)/)
        .map((part, index) => {
          if (index % 2 === 1) return part;
          return part
            .replace(
              /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
              (_, target, title) => `](${rewriteLinkTarget(target, pathToSlug)}${title})`,
            )
            .replace(
              /href="([^"]+)"/g,
              (_, target) => `href="${rewriteLinkTarget(target, pathToSlug)}"`,
            );
        })
        .join("");
    })
    .join("\n");
}

/**
 * Read every `.md` page in `sourceDir` and return the files to write:
 * `{ pages: [{ slug, path, url, title, lead, section, markdown }] }`.
 */
export function buildDocsBundle({ sourceDir, shellFile }) {
  const files = readdirSync(sourceDir)
    .filter((name) => extname(name).toLowerCase() === ".md")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const pathToSlug = new Map();
  const drafts = [];
  for (const name of files) {
    const slug = basename(name, extname(name));
    if (!SLUG_PATTERN.test(slug) || RESERVED_SLUGS.has(slug)) {
      throw new Error(
        `sync-docs: page "${name}" has an unsupported file name; use lowercase letters, digits, and hyphens (and not "index").`,
      );
    }
    const source = readFileSync(join(sourceDir, name), "utf-8")
      .replace(/^﻿/, "")
      .replace(/\r\n?/g, "\n");
    const { fields, body } = splitFrontmatter(source);
    if (typeof fields.title !== "string" || fields.title === "") {
      throw new Error(`sync-docs: page "${name}" has no frontmatter title.`);
    }
    const path = routeForSlug(slug);
    pathToSlug.set(path, slug);
    drafts.push({ slug, path, title: fields.title, lead: fields.lead ?? "", body });
  }

  const sectionOf = new Map();
  const navOrder = new Map();
  if (shellFile && existsSync(shellFile)) {
    for (const section of parseNavSections(readFileSync(shellFile, "utf-8"))) {
      for (const path of section.paths) {
        const slug = pathToSlug.get(path);
        if (!slug || sectionOf.has(slug)) continue;
        sectionOf.set(slug, section.label);
        navOrder.set(slug, navOrder.size);
      }
    }
  }

  const pages = drafts.map((draft) => ({
    slug: draft.slug,
    path: draft.path,
    url: `${SITE_ORIGIN}${draft.path}`,
    title: draft.title,
    lead: draft.lead,
    section: sectionOf.get(draft.slug) ?? "Other",
    markdown: renderPage(draft, rewriteLinks(draft.body, pathToSlug)),
  }));

  // Sidebar order first, then any page the sidebar does not list.
  pages.sort((a, b) => {
    const left = navOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
    const right = navOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  return { pages };
}

function renderPage(draft, body) {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(draft.title)}`,
    ...(draft.lead ? [`lead: ${JSON.stringify(draft.lead)}`] : []),
    `url: ${SITE_ORIGIN}${draft.path}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${body.startsWith("\n") ? "" : "\n"}${body.replace(/\n*$/, "\n")}`;
}

export function renderIndexMarkdown(pages) {
  const lines = [
    "# pracht docs",
    "",
    "The pracht documentation for this installed version of `@pracht/cli`. Read a page",
    "with `pracht docs <slug>` or open `<slug>.md` in this directory; search with",
    "`pracht docs --search <query>`. Online: " + SITE_ORIGIN + "/docs",
  ];
  let section = null;
  for (const page of pages) {
    if (page.section !== section) {
      section = page.section;
      lines.push("", `## ${section}`, "");
    }
    lines.push(`- [${page.title}](${page.slug}.md)${page.lead ? ` — ${page.lead}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Write the bundle into `targetDir`, replacing whatever was there. */
export function writeDocsBundle({ pages }, targetDir) {
  rmSync(targetDir, { force: true, recursive: true });
  mkdirSync(targetDir, { recursive: true });
  for (const page of pages) {
    writeFileSync(join(targetDir, `${page.slug}.md`), page.markdown, "utf-8");
  }
  const index = {
    site: SITE_ORIGIN,
    pages: pages.map(({ slug, path, url, title, lead, section }) => ({
      slug,
      path,
      url,
      title,
      lead,
      section,
    })),
  };
  writeFileSync(join(targetDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  writeFileSync(join(targetDir, "index.md"), renderIndexMarkdown(pages), "utf-8");
}
