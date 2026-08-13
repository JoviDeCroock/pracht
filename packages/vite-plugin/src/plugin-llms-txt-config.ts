import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";

export interface ResolvedLlmsTxtConfig {
  title: string;
  description?: string;
  origin?: string;
  include?: string[];
  exclude?: string[];
}

/**
 * Fill llms.txt title/description from the app's package.json when the user
 * did not set them explicitly. Returns null when the feature is disabled so
 * the server module codegen stays byte-for-byte unchanged.
 */
export function resolveLlmsTxtConfig(
  resolved: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): ResolvedLlmsTxtConfig | null {
  if (!resolved.llmsTxt) return null;

  let pkg: { name?: unknown; description?: unknown } = {};
  try {
    pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
  } catch {}

  const config: ResolvedLlmsTxtConfig = {
    title: resolved.llmsTxt.title ?? (typeof pkg.name === "string" && pkg.name ? pkg.name : "App"),
  };
  const description =
    resolved.llmsTxt.description ??
    (typeof pkg.description === "string" && pkg.description ? pkg.description : undefined);
  if (description) config.description = description;
  if (resolved.llmsTxt.origin) config.origin = resolved.llmsTxt.origin;
  if (resolved.llmsTxt.include) config.include = resolved.llmsTxt.include;
  if (resolved.llmsTxt.exclude?.length) config.exclude = resolved.llmsTxt.exclude;
  return config;
}
