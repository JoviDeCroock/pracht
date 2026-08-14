import { displayPath, type ProjectConfig } from "./project.js";
import { createCheck, type Check } from "./verification-helpers.js";

const MARKDOWN_PAGE_RE = /\.mdx?$/;
// Plugin specifiers that transform Markdown/MDX into a renderable module,
// matched against the raw vite config text. Necessarily a heuristic: a custom
// or re-exported plugin is invisible here, which is why this warns and says so
// rather than asserting the app is broken.
const MARKDOWN_PLUGIN_HINTS = ["@mdx-js/rollup", "vite-plugin-mdx", "vite-plugin-markdown"];

/**
 * A `.md` / `.mdx` route is registered like any other, but nothing renders it
 * unless a transform plugin is configured: Vite hands the raw Markdown to the
 * JS parser, so the route 500s at request time with `Invalid Character` and
 * `pracht build` fails with a raw parser stack. Both `doctor` and `verify`
 * would otherwise report the app healthy.
 */
export function collectMarkdownTransformCheck(
  project: ProjectConfig,
  checks: Check[],
  files: string[],
): void {
  const markdownFiles = files.filter((file) => MARKDOWN_PAGE_RE.test(file));
  if (markdownFiles.length === 0) return;

  const config = project.rawConfig;
  if (MARKDOWN_PLUGIN_HINTS.some((hint) => config.includes(hint))) return;

  const shown = markdownFiles
    .slice(0, 3)
    .map((file) => JSON.stringify(displayPath(project.root, file)))
    .join(", ");

  checks.push(
    createCheck(
      "warning",
      `${markdownFiles.length} Markdown route${markdownFiles.length === 1 ? "" : "s"} ` +
        `(${shown}${markdownFiles.length > 3 ? ", ..." : ""}) but no known Markdown transform ` +
        "plugin in the vite config. Pracht does not transform Markdown: without a plugin such as " +
        "`@mdx-js/rollup` registered alongside `pracht()`, Vite hands the raw source to the JS " +
        "parser and these routes fail at request and build time. Ignore this if you register a " +
        "custom or re-exported Markdown plugin.",
    ),
  );
}
