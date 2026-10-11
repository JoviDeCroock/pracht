import { artifactFileName, normalizeRoutePath } from "./path.ts";
import type {
  ContentArtifact,
  ContentArtifactGenerator,
  ContentDocument,
  ContentLocaleOptions,
  ContentPathContext,
} from "./types.ts";

export interface RawContentArtifactsOptions<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
> {
  path: (document: ContentDocument<TFrontmatter, TCompiled>) => string | false;
  /** Emit the full source (default) or the frontmatter-free body. */
  representation?: "raw" | "body";
  contentType?: string;
}

/** Emit selected source documents as ordinary static assets. */
export function rawContentArtifacts<TFrontmatter extends Record<string, unknown>, TCompiled>(
  options: RawContentArtifactsOptions<TFrontmatter, TCompiled>,
): ContentArtifactGenerator<TFrontmatter, TCompiled> {
  // Validate at definition time rather than when the generator runs: a bad
  // option would otherwise surface as a bare TypeError from inside a Vite
  // build hook, naming neither this helper nor the collection that used it.
  assertOptionsObject(options, "rawContentArtifacts");
  if (typeof options.path !== "function") {
    throw new TypeError(
      "rawContentArtifacts() requires a `path` function that maps a document to its artifact path, for example `{ path: (document) => `${document.path}.md` }`.",
    );
  }
  if (options.representation !== undefined && !["raw", "body"].includes(options.representation)) {
    throw new TypeError(
      `rawContentArtifacts() \`representation\` must be "raw" or "body", received ${JSON.stringify(options.representation)}.`,
    );
  }

  return ({ documents }) =>
    documents.flatMap((document) => {
      const path = options.path(document);
      if (path === false) return [];
      return [
        {
          path,
          source: options.representation === "body" ? document.body : document.raw,
          contentType: options.contentType ?? "text/markdown; charset=utf-8",
        },
      ];
    });
}

export interface LlmsTxtSection {
  /** `##` heading in the summary, also the label of the section's full-text file. */
  heading: string;
  match: string | ((document: ContentDocument<Record<string, unknown>, unknown>) => boolean);
  /** List the section's entries under the summary's single trailing `## Optional` heading. */
  optional?: boolean;
  /**
   * Emit a companion file at this path that inlines only this section's
   * documents, for example `/llms-guides.txt`. The summary lists it under
   * `## Optional`. Not emitted when the section matches no document.
   */
  fullPath?: string;
}

export interface LlmsTxtArtifactsOptions {
  title: string;
  description?: string;
  /** Absolute site origin, optionally with a base path, prefixed to every link. */
  origin?: string;
  /** Free-form Markdown lines placed between the description and the first section. */
  details?: readonly string[];
  sections?: readonly LlmsTxtSection[];
  summaryPath?: string;
  /** Set false to skip the full-source companion. Defaults to `/llms-full.txt`. */
  fullPath?: string | false;
  /**
   * Root-relative URL each summary entry links to, joined to `origin`.
   * Defaults to the document's route, `document.path`.
   */
  link?: (document: ContentDocument<Record<string, unknown>, unknown>) => string;
  titleField?: string;
  descriptionField?: string;
}

const MARKDOWN = "text/markdown; charset=utf-8";

/**
 * Opt-in frontmatter-driven llms.txt and llms-full.txt artifacts. This is
 * deliberately a collection helper, not framework policy: the core Pracht
 * generator remains app-graph driven.
 */
export function llmsTxtArtifacts<TFrontmatter extends Record<string, unknown>, TCompiled>(
  options: LlmsTxtArtifactsOptions,
): ContentArtifactGenerator<TFrontmatter, TCompiled> {
  assertOptionsObject(options, "llmsTxtArtifacts");
  if (typeof options.title !== "string" || !options.title.trim()) {
    throw new TypeError("llmsTxtArtifacts() requires a non-empty `title` string.");
  }
  if (options.link !== undefined && typeof options.link !== "function") {
    throw new TypeError(
      "llmsTxtArtifacts() `link` must be a function that maps a document to a root-relative URL, for example `(document) => `${document.path}.md``.",
    );
  }
  const origin = normalizeOrigin(options.origin);
  const sections = normalizeSections(options.sections);
  const summaryPath = options.summaryPath ?? "/llms.txt";
  const fullPath = options.fullPath === undefined ? "/llms-full.txt" : options.fullPath;
  if (fullPath !== false && typeof fullPath !== "string") {
    throw new TypeError(
      "llmsTxtArtifacts() `fullPath` must be an artifact path string, or false to skip the full-text file.",
    );
  }
  assertDistinctArtifactPaths([
    ["summaryPath", summaryPath],
    ...(fullPath === false ? [] : [["fullPath", fullPath] as const]),
    ...sections.flatMap((section, index) =>
      section.fullPath === undefined
        ? []
        : [[`sections[${index}].fullPath`, section.fullPath] as const],
    ),
  ]);
  const titleField = options.titleField ?? "title";
  const descriptionField = options.descriptionField ?? "lead";
  const title = singleLineText(options.title);
  const description = options.description ? singleLineText(options.description) : undefined;

  return ({ collection, documents }) => {
    const entryFor = (document: ContentDocument<TFrontmatter, TCompiled>) => {
      const titleValue = stringField(document.frontmatter, titleField);
      const descriptionValue = stringField(document.frontmatter, descriptionField);
      return {
        document,
        title: singleLineText(titleValue ?? document.path),
        description: descriptionValue ? singleLineText(descriptionValue) : undefined,
        url: joinOrigin(origin, linkFor(document, options.link)),
      };
    };
    type Entry = ReturnType<typeof entryFor>;

    const header = [`# ${title}`];
    if (description) header.push("", `> ${description}`);

    const summary = [...header];
    if (options.details?.length) summary.push("", ...options.details);

    const optionalLines: string[] = [];
    const bundles: { label: string; path: string; entries: Entry[] }[] = [];
    const everything: Entry[] = [];
    const inlined = new Set<string>();

    for (const section of sections) {
      const matched = documents
        .filter((document) => matchesSection(document, section.match, collection.locales))
        .map(entryFor);
      if (!matched.length) continue;
      const lines = matched.map(
        (entry) =>
          `- [${escapeMarkdownLinkLabel(entry.title)}](${escapeMarkdownLinkDestination(entry.url)})${entry.description ? `: ${entry.description}` : ""}`,
      );
      if (section.optional) optionalLines.push(...lines);
      else summary.push("", `## ${section.heading}`, "", ...lines);

      if (section.fullPath !== undefined) {
        bundles.push({
          label: section.heading,
          path: normalizeRoutePath(section.fullPath, "content artifact path"),
          entries: matched,
        });
      }
      for (const entry of matched) {
        const key = `${entry.document.locale ?? ""}\0${entry.document.id}`;
        if (inlined.has(key)) continue;
        inlined.add(key);
        everything.push(entry);
      }
    }

    const fullText = (heading: string | undefined, entries: readonly Entry[]) => {
      const lines = heading ? [`# ${title}: ${heading}`] : [`# ${title}`];
      if (description) lines.push("", `> ${description}`);
      lines.push("");
      for (const entry of entries) {
        lines.push("---", "", `# ${entry.title}`, "");
        if (entry.description) lines.push(`> ${entry.description}`, "");
        lines.push(entry.document.body.trim(), "");
      }
      return `${lines.join("\n")}\n`;
    };

    const companions: ContentArtifact[] = bundles.map((bundle) => ({
      path: bundle.path,
      source: fullText(bundle.label, bundle.entries),
      contentType: MARKDOWN,
    }));
    const full =
      fullPath === false
        ? undefined
        : {
            path: normalizeRoutePath(fullPath, "content artifact path"),
            source: fullText(undefined, everything),
            contentType: MARKDOWN,
          };

    // Section bundles repeat pages the summary already links, so they are
    // listed as skippable `## Optional` entries: a tool that expands every
    // required link into a context window should not read each page twice.
    if (companions.length) {
      const describe = (count: number, source: string, scope: string) =>
        `${count} ${count === 1 ? "page" : "pages"} ${scope} in one file, ${wordCount(source)} words`;
      for (const [index, bundle] of bundles.entries()) {
        optionalLines.push(
          `- [${escapeMarkdownLinkLabel(`${bundle.label} (full text)`)}](${escapeMarkdownLinkDestination(joinOrigin(origin, bundle.path))}): ${describe(bundle.entries.length, String(companions[index].source), `from ${bundle.label}`)}`,
        );
      }
      if (full) {
        optionalLines.push(
          `- [All pages (full text)](${escapeMarkdownLinkDestination(joinOrigin(origin, full.path))}): ${describe(everything.length, full.source, "from every section")}`,
        );
      }
    }
    if (optionalLines.length) summary.push("", "## Optional", "", ...optionalLines);

    return [
      { path: summaryPath, source: `${summary.join("\n")}\n`, contentType: MARKDOWN },
      ...(full ? [full] : []),
      ...companions,
    ];
  };
}

function matchesSection<TFrontmatter extends Record<string, unknown>, TCompiled>(
  document: ContentDocument<TFrontmatter, TCompiled>,
  match: LlmsTxtSection["match"],
  locales: ContentLocaleOptions | undefined,
): boolean {
  if (typeof match === "function") {
    return match(document as ContentDocument<Record<string, unknown>, unknown>);
  }
  // Match the locale-neutral route, not the published one. The default locale
  // strategy prefixes translations (`/fr/docs/guide`), so a section written as
  // the natural `match: "/docs"` would otherwise select the default locale and
  // silently drop every translation from an artifact that claims to index the
  // collection. Use a `match` function to index one locale deliberately.
  const path = localeNeutralPath(document.path, document.locale, locales);
  const prefix = match.endsWith("/") && match !== "/" ? match.slice(0, -1) : match;
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

/** Inverse of the collection's generated locale route prefix. */
function localeNeutralPath(
  path: string,
  locale: string | undefined,
  locales: ContentLocaleOptions | undefined,
): string {
  if (!locale || !locales) return path;
  const strategy = locales.routePrefix ?? "non-default";
  if (strategy === "never") return path;
  if (strategy !== "always" && locale === locales.default) return path;
  const prefix = `/${locale}`;
  if (path === prefix) return "/";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

function normalizeOrigin(origin: unknown): string | undefined {
  if (origin === undefined) return undefined;
  let url: URL | undefined;
  try {
    url = typeof origin === "string" ? new URL(origin) : undefined;
  } catch {
    url = undefined;
  }
  if (
    !url ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      `llmsTxtArtifacts() \`origin\` must be an absolute http(s) URL without a query or fragment, for example "https://example.com", received ${JSON.stringify(origin)}.`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeSections(sections: unknown): readonly LlmsTxtSection[] {
  if (sections === undefined) return [{ heading: "Pages", match: () => true }];
  if (!Array.isArray(sections)) {
    throw new TypeError("llmsTxtArtifacts() `sections` must be an array of section objects.");
  }
  return sections.map((section: unknown, index): LlmsTxtSection => {
    const label = `llmsTxtArtifacts() \`sections[${index}]\``;
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new TypeError(`${label} must be an object with \`heading\` and \`match\`.`);
    }
    const { heading, match, optional, fullPath } = section as Record<string, unknown>;
    if (typeof heading !== "string" || !heading.trim() || /[\r\n]/.test(heading)) {
      throw new TypeError(`${label}.heading must be a non-empty single-line string.`);
    }
    if (typeof match !== "function" && (typeof match !== "string" || !match.startsWith("/"))) {
      throw new TypeError(
        `${label}.match must be a route prefix starting with "/" or a function that selects documents.`,
      );
    }
    if (optional !== undefined && typeof optional !== "boolean") {
      throw new TypeError(`${label}.optional must be a boolean.`);
    }
    if (fullPath !== undefined && typeof fullPath !== "string") {
      throw new TypeError(
        `${label}.fullPath must be an artifact path string such as "/llms-guides.txt".`,
      );
    }
    return {
      heading: heading.trim(),
      match: match as LlmsTxtSection["match"],
      ...(optional === undefined ? {} : { optional }),
      ...(fullPath === undefined ? {} : { fullPath }),
    };
  });
}

/**
 * Every file this helper emits must have its own path. The collection would
 * reject a duplicate anyway, but only once the generator runs, naming neither
 * option involved.
 */
function assertDistinctArtifactPaths(paths: readonly (readonly [string, string])[]): void {
  const seen: { option: string; key: string }[] = [];
  for (const [option, path] of paths) {
    try {
      artifactFileName(path);
    } catch (error) {
      throw new TypeError(
        `llmsTxtArtifacts() \`${option}\` is not a valid artifact path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Case-folded, like the build's own preflight: case-insensitive
    // filesystems would write both files to one name.
    const key = normalizeRoutePath(path, "content artifact path").toLowerCase();
    for (const other of seen) {
      if (other.key === key) {
        throw new TypeError(
          `llmsTxtArtifacts() \`${other.option}\` and \`${option}\` both emit ${JSON.stringify(path)}; give each file its own path.`,
        );
      }
      if (key.startsWith(`${other.key}/`) || other.key.startsWith(`${key}/`)) {
        throw new TypeError(
          `llmsTxtArtifacts() \`${other.option}\` and \`${option}\` would need ${JSON.stringify(path)} to be both a file and a directory.`,
        );
      }
    }
    seen.push({ option, key });
  }
}

function linkFor<TFrontmatter extends Record<string, unknown>, TCompiled>(
  document: ContentDocument<TFrontmatter, TCompiled>,
  link: LlmsTxtArtifactsOptions["link"],
): string {
  if (!link) return document.path;
  const value: unknown = link(document as ContentDocument<Record<string, unknown>, unknown>);
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw new TypeError(
      `llmsTxtArtifacts() \`link\` must return a root-relative URL starting with "/"; received ${JSON.stringify(value)} for document ${JSON.stringify(document.path)}.`,
    );
  }
  return value;
}

/** Whitespace-separated tokens containing a letter or digit, so Markdown syntax is not counted. */
function wordCount(source: string): number {
  return source.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

function assertOptionsObject(options: unknown, helper: string): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${helper}() expects an options object.`);
  }
}

function stringField(frontmatter: Record<string, unknown>, field: string): string | undefined {
  const value = frontmatter[field];
  return typeof value === "string" && value ? value : undefined;
}

function singleLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownLinkDestination(value: string): string {
  // A space, control character, or angle bracket would end or corrupt a
  // Markdown link destination; percent-encoding them keeps the same URL.
  return value
    .replace(/[\s\p{Cc}<>]/gu, (character) => encodeURIComponent(character))
    .replace(/([\\()])/g, "\\$1");
}

/** `origin` is already normalized without a trailing slash. */
function joinOrigin(origin: string | undefined, path: string): string {
  return `${origin ?? ""}${path}`;
}

/** Type-only convenience for authoring custom route functions. */
export type ContentRoute = (context: ContentPathContext) => string | false;
