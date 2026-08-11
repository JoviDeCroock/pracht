import { parse } from "yaml";

import type { ParsedContent } from "./types.ts";

const FRONTMATTER = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)([\s\S]*)$/;

/** Parse YAML frontmatter while preserving the exact raw document separately. */
export function parseFrontmatter<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): ParsedContent<TFrontmatter> {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { body: raw, frontmatter: {} as TFrontmatter };

  const value = parse(match[1]);
  if (value == null) return { body: match[2], frontmatter: {} as TFrontmatter };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Content frontmatter must be a YAML mapping.");
  }

  return { body: match[2], frontmatter: value as TFrontmatter };
}
