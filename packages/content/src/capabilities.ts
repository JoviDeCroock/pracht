import type { CapabilityRunArgs, JsonSchema } from "@pracht/capabilities";

import { normalizeRoutePath } from "./path.ts";
import type { ContentCollection, ContentDocument } from "./types.ts";

interface ContentPageInput {
  locale?: string;
  path: string;
}

interface ContentPageOutput {
  content: string;
  found: boolean;
  locale: string;
  path: string;
  title: string;
}

interface ContentSearchInput {
  locale?: string;
  limit?: number;
  query: string;
}

interface ContentSearchResult {
  path: string;
  score: number;
  snippet: string;
  title: string;
}

interface ContentSearchOutput {
  results: ContentSearchResult[];
}

export interface ContentCapabilityOptions {
  titleField?: string;
}

export interface ContentCapabilityFields<TInput, TOutput> {
  input: JsonSchema;
  output: JsonSchema;
  run: (args: CapabilityRunArgs<TInput>) => Promise<TOutput>;
}

/**
 * Opt-in page capability fields. Keep the app-owned `defineCapability({ ... })`
 * call literal so Pracht can statically verify its title, effect, exposure,
 * middleware, and agent policy.
 */
export function createContentPageCapability<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
>(
  collection: ContentCollection<TFrontmatter, TCompiled>,
  options: ContentCapabilityOptions = {},
): ContentCapabilityFields<ContentPageInput, ContentPageOutput> {
  return {
    input: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Exact root-relative page route." },
        locale: {
          type: "string",
          minLength: 1,
          ...(collection.locales ? { enum: [...collection.locales.supported] } : {}),
          description: "Preferred content locale.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        path: { type: "string" },
        locale: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["found", "path", "locale", "title", "content"],
      additionalProperties: false,
    },
    async run({ input }) {
      let path: string;
      try {
        path = normalizeRoutePath(input.path);
      } catch {
        return missingPage(input.path, input.locale);
      }
      if (
        input.locale &&
        collection.locales &&
        !collection.locales.supported.includes(input.locale)
      ) {
        return missingPage(path, input.locale);
      }
      const document = await collection.getByRoute(path, { locale: input.locale });
      if (!document) {
        return missingPage(path, input.locale);
      }
      return {
        content: document.body,
        found: true,
        locale: document.locale ?? "",
        path: document.path,
        title: documentTitle(document, options.titleField),
      };
    },
  };
}

function missingPage(path: string, locale: string | undefined): ContentPageOutput {
  return { content: "", found: false, locale: locale ?? "", path, title: "" };
}

/** Opt-in, dependency-free full-text search capability fields over a collection. */
export function createContentSearchCapability<
  TFrontmatter extends Record<string, unknown>,
  TCompiled,
>(
  collection: ContentCollection<TFrontmatter, TCompiled>,
  options: ContentCapabilityOptions = {},
): ContentCapabilityFields<ContentSearchInput, ContentSearchOutput> {
  return {
    input: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        locale: {
          type: "string",
          minLength: 1,
          ...(collection.locales ? { enum: [...collection.locales.supported] } : {}),
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              title: { type: "string" },
              snippet: { type: "string" },
              score: { type: "integer" },
            },
            required: ["path", "title", "snippet", "score"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    async run({ input }) {
      const terms = tokenize(input.query);
      if (!terms.length) return { results: [] };
      const documents = await collection.all();
      const ranked = documents
        .filter(
          (document) => !collection.locales || !input.locale || document.locale === input.locale,
        )
        .map((document) => rankDocument(document, terms, options.titleField))
        .filter((result): result is ContentSearchResult => result !== undefined)
        .sort((left, right) => right.score - left.score || compare(left.path, right.path));
      return { results: ranked.slice(0, input.limit ?? 5) };
    },
  };
}

function rankDocument<TFrontmatter extends Record<string, unknown>, TCompiled>(
  document: ContentDocument<TFrontmatter, TCompiled>,
  terms: readonly string[],
  titleField?: string,
): ContentSearchResult | undefined {
  const title = documentTitle(document, titleField);
  const lowerTitle = title.toLocaleLowerCase();
  const normalizedBody = normalizeBody(document.body);
  const lowerBody = normalizedBody.toLocaleLowerCase();
  let score = 0;
  let firstMatch = -1;
  for (const term of terms) {
    const titleMatches = occurrences(lowerTitle, term);
    const bodyMatches = occurrences(lowerBody, term);
    if (titleMatches + bodyMatches === 0) return undefined;
    score += titleMatches * 10 + bodyMatches;
    const index = lowerBody.indexOf(term);
    if (index !== -1 && (firstMatch === -1 || index < firstMatch)) firstMatch = index;
  }
  return {
    path: document.path,
    score,
    snippet: snippet(normalizedBody, firstMatch),
    title,
  };
}

function documentTitle<TFrontmatter extends Record<string, unknown>, TCompiled>(
  document: ContentDocument<TFrontmatter, TCompiled>,
  field = "title",
): string {
  const value = document.frontmatter[field];
  return typeof value === "string" && value ? value : document.path;
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function occurrences(value: string, term: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(term, offset)) !== -1) {
    count++;
    offset += term.length;
  }
  return count;
}

function snippet(body: string, match: number): string {
  if (body.length <= 240) return body;
  const start = Math.max(0, Math.min(body.length - 240, match < 0 ? 0 : match - 80));
  return `${start > 0 ? "…" : ""}${body.slice(start, start + 240).trim()}${start + 240 < body.length ? "…" : ""}`;
}

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
