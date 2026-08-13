/**
 * llms.txt generation (https://llmstxt.org) from the resolved app graph.
 *
 * `pracht build` writes the result to `dist/client/llms.txt` and the dev SSR
 * middleware serves it live at `/llms.txt` when the vite plugin's `llmsTxt`
 * option is enabled. Output is deterministic: entries are sorted by path and
 * dynamic SSG/ISG routes are expanded through their `getStaticPaths()`
 * export. Dynamic routes without enumerable instances (e.g. SSR routes with
 * params) are skipped — they have no concrete URL an agent could fetch.
 * HTTP-exposed capabilities are listed with their dispatch endpoint, effect
 * class, and description so agents can discover callable operations, not
 * just readable pages.
 */

import {
  collectLlmsTxtApiEntries,
  collectLlmsTxtCapabilityEntries,
  collectLlmsTxtPageEntries,
} from "./llms-txt-entries.ts";
import { createLlmsTxtExclusionMatcher } from "./llms-txt-exclusions.ts";
import type { BuildLlmsTxtOptions } from "./llms-txt-types.ts";

export type { BuildLlmsTxtOptions, LlmsTxtSection } from "./llms-txt-types.ts";

export async function buildLlmsTxt(options: BuildLlmsTxtOptions): Promise<string> {
  const include = options.include ?? ["pages", "api", "capabilities"];
  const origin = options.origin?.replace(/\/$/, "") ?? "";
  const isExcluded = createLlmsTxtExclusionMatcher(options.exclude);

  const lines: string[] = [`# ${options.title}`];
  if (options.description) {
    lines.push("", `> ${options.description}`);
  }

  if (include.includes("pages")) {
    const pages = (await collectLlmsTxtPageEntries(options.app.routes, options.registry)).filter(
      (page) => !isExcluded(page.path),
    );
    if (pages.length > 0) {
      lines.push("", "## Pages", "");
      for (const page of pages) {
        const note = page.markdown ? ": supports `Accept: text/markdown`" : "";
        lines.push(`- [${page.path}](${origin}${page.path})${note}`);
      }
    }
  }

  if (include.includes("api")) {
    const apiEntries = (
      await collectLlmsTxtApiEntries(options.apiRoutes ?? [], options.registry)
    ).filter((entry) => !isExcluded(entry.path));
    if (apiEntries.length > 0) {
      lines.push("", "## API", "");
      for (const entry of apiEntries) {
        const note = entry.methods.length > 0 ? `: ${entry.methods.join(", ")}` : "";
        lines.push(`- [${entry.path}](${origin}${entry.path})${note}`);
      }
    }
  }

  if (include.includes("capabilities")) {
    const capabilityEntries = (
      await collectLlmsTxtCapabilityEntries(options.app, options.registry)
    ).filter((entry) => !isExcluded(entry.path));
    if (capabilityEntries.length > 0) {
      lines.push("", "## Capabilities", "");
      for (const entry of capabilityEntries) {
        const confirmation = entry.effect === "destructive" ? ", requires confirmation" : "";
        const description = entry.description ? ` — ${entry.description}` : "";
        lines.push(
          `- [${entry.name}](${origin}${entry.path}): POST (${entry.effect}${confirmation})${description}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
