import type {
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
  heading: string;
  match: string | ((document: ContentDocument<Record<string, unknown>, unknown>) => boolean);
  optional?: boolean;
}

export interface LlmsTxtArtifactsOptions {
  title: string;
  description?: string;
  origin?: string;
  details?: readonly string[];
  sections?: readonly LlmsTxtSection[];
  summaryPath?: string;
  /** Set false to skip the full-source companion. Defaults to `/llms-full.txt`. */
  fullPath?: string | false;
  titleField?: string;
  descriptionField?: string;
}

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

  const summaryPath = options.summaryPath ?? "/llms.txt";
  const fullPath = options.fullPath === undefined ? "/llms-full.txt" : options.fullPath;
  const titleField = options.titleField ?? "title";
  const descriptionField = options.descriptionField ?? "lead";

  return ({ collection, documents }) => {
    const sections = options.sections ?? [{ heading: "Pages", match: () => true }];
    const summary = [`# ${options.title}`];
    if (options.description) summary.push("", `> ${options.description}`);
    if (options.details?.length) summary.push("", ...options.details);

    const full = [`# ${options.title}`];
    if (options.description) full.push("", `> ${options.description}`);
    full.push("");

    const emitted = new Set<string>();
    for (const section of sections) {
      const matched = documents.filter((document) =>
        matchesSection(document, section.match, collection.locales),
      );
      if (!matched.length) continue;
      summary.push("", section.optional ? "## Optional" : `## ${section.heading}`, "");
      for (const document of matched) {
        const title = singleLineText(
          stringField(document.frontmatter, titleField) ?? document.path,
        );
        const descriptionValue = stringField(document.frontmatter, descriptionField);
        const description = descriptionValue ? singleLineText(descriptionValue) : undefined;
        const url = joinOrigin(options.origin, document.path);
        summary.push(
          `- [${escapeMarkdownLinkLabel(title)}](${url})${description ? `: ${description}` : ""}`,
        );

        if (!emitted.has(`${document.locale ?? ""}\0${document.id}`)) {
          emitted.add(`${document.locale ?? ""}\0${document.id}`);
          full.push("---", "", `# ${title}`, "");
          if (description) full.push(`> ${description}`, "");
          full.push(document.body.trim(), "");
        }
      }
    }

    return [
      {
        path: summaryPath,
        source: `${summary.join("\n")}\n`,
        contentType: "text/markdown; charset=utf-8",
      },
      ...(fullPath === false
        ? []
        : [
            {
              path: fullPath,
              source: `${full.join("\n")}\n`,
              contentType: "text/markdown; charset=utf-8",
            },
          ]),
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

function joinOrigin(origin: string | undefined, path: string): string {
  return `${origin?.replace(/\/$/, "") ?? ""}${path}`;
}

/** Type-only convenience for authoring custom route functions. */
export type ContentRoute = (context: ContentPathContext) => string | false;
