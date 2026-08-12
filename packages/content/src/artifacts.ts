import type { ContentArtifactGenerator, ContentDocument, ContentPathContext } from "./types.ts";

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
  const summaryPath = options.summaryPath ?? "/llms.txt";
  const fullPath = options.fullPath === undefined ? "/llms-full.txt" : options.fullPath;
  const titleField = options.titleField ?? "title";
  const descriptionField = options.descriptionField ?? "lead";

  return ({ documents }) => {
    const sections = options.sections ?? [{ heading: "Pages", match: () => true }];
    const summary = [`# ${options.title}`];
    if (options.description) summary.push("", `> ${options.description}`);
    if (options.details?.length) summary.push("", ...options.details);

    const full = [`# ${options.title}`];
    if (options.description) full.push("", `> ${options.description}`);
    full.push("");

    const emitted = new Set<string>();
    for (const section of sections) {
      const matched = documents.filter((document) => matchesSection(document, section.match));
      if (!matched.length) continue;
      summary.push("", section.optional ? "## Optional" : `## ${section.heading}`, "");
      for (const document of matched) {
        const title = stringField(document.frontmatter, titleField) ?? document.path;
        const description = stringField(document.frontmatter, descriptionField);
        const url = joinOrigin(options.origin, document.path);
        summary.push(`- [${title}](${url})${description ? `: ${description}` : ""}`);

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
): boolean {
  if (typeof match === "function") {
    return match(document as ContentDocument<Record<string, unknown>, unknown>);
  }
  const prefix = match.endsWith("/") && match !== "/" ? match.slice(0, -1) : match;
  return prefix === "/" || document.path === prefix || document.path.startsWith(`${prefix}/`);
}

function stringField(frontmatter: Record<string, unknown>, field: string): string | undefined {
  const value = frontmatter[field];
  return typeof value === "string" && value ? value : undefined;
}

function joinOrigin(origin: string | undefined, path: string): string {
  return `${origin?.replace(/\/$/, "") ?? ""}${path}`;
}

/** Type-only convenience for authoring custom route functions. */
export type ContentRoute = (context: ContentPathContext) => string | false;
