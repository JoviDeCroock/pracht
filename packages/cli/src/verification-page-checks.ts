/** Pages-router and Markdown route verification. */

import { existsSync } from "node:fs";

import { displayPath, resolveProjectPath, type ProjectConfig } from "./project.js";
import {
  createCheck,
  isWithinDirectory,
  PAGE_SOURCE_RE,
  type Check,
} from "./verification-helpers.js";
import {
  collectDuplicateRoutePaths,
  describePagesFile,
  scanPagesDirectory,
  type PagesRoute,
} from "./verification-pages.js";

export function collectPagesVerification(
  project: ProjectConfig,
  checks: Check[],
  { changedFiles, scope }: { changedFiles: string[]; scope: string },
): void {
  const pagesDir = resolveProjectPath(project.root, project.pagesDir);
  if (!existsSync(pagesDir)) {
    checks.push(createCheck("error", `Pages directory is missing at ${project.pagesDir}.`));
    return;
  }

  const pages = scanPagesDirectory(pagesDir);
  const routes = pages.filter((page) => page.kind === "route");
  const notFoundPages = pages.filter((page) => page.kind === "not-found");
  const appShells = pages.filter((page) => page.kind === "shell");
  const duplicates = collectDuplicateRoutePaths(routes as PagesRoute[]).map((entry) => ({
    ...entry,
    files: entry.files.map((file) => displayPath(project.root, file)),
  }));

  if (!project.pagesDefaultRenderIsStatic) {
    checks.push(
      createCheck(
        "warning",
        "pagesDefaultRender could not be resolved statically. The build evaluates the live " +
          "configuration and will still reject ISG pages without a revalidation policy.",
      ),
    );
  } else if (!new Set(["spa", "ssr", "ssg", "isg"]).has(project.pagesDefaultRender)) {
    checks.push(
      createCheck("error", 'pagesDefaultRender must resolve to "spa", "ssr", "ssg", or "isg".'),
    );
  }

  for (const shell of appShells) {
    if (shell.hasRevalidateExport) {
      checks.push(
        createCheck(
          "error",
          `Pages app shell ${JSON.stringify(displayPath(project.root, shell.file))} exports ` +
            "REVALIDATE, but app shells are not ISG routes. Declare the policy on each ISG " +
            "page instead.",
        ),
      );
    }
  }

  for (const page of notFoundPages) {
    if (page.hasRevalidateExport) {
      checks.push(
        createCheck(
          "error",
          `Pages not-found module ${JSON.stringify(displayPath(project.root, page.file))} exports ` +
            "REVALIDATE, but not-found responses are never ISG routes.",
        ),
      );
    }
  }

  for (const route of routes as PagesRoute[]) {
    const display = displayPath(project.root, route.file);
    const render =
      route.renderMode ??
      (project.pagesDefaultRenderIsStatic ? project.pagesDefaultRender : undefined);
    if (route.revalidate.kind === "invalid") {
      checks.push(
        createCheck(
          "error",
          `Pages route ${JSON.stringify(display)} must export REVALIDATE as a positive integer ` +
            "literal number of seconds (for example, `export const REVALIDATE = 60`).",
        ),
      );
      continue;
    }
    if (render === "isg" && route.revalidate.kind === "missing") {
      checks.push(
        createCheck(
          "error",
          `Pages route ${JSON.stringify(display)} uses render mode "isg" but does not export a ` +
            "revalidation policy. Add `export const REVALIDATE = 60` with a positive integer " +
            "number of seconds, or use another render mode.",
        ),
      );
      continue;
    }
    if (render === undefined && route.revalidate.kind === "time") {
      checks.push(
        createCheck(
          "error",
          `Pages route ${JSON.stringify(display)} exports REVALIDATE, but its effective render ` +
            'mode cannot be resolved statically. Export `RENDER_MODE = "isg"` on the page ' +
            "or use a statically resolvable pagesDefaultRender value.",
        ),
      );
      continue;
    }
    if (render !== "isg" && route.revalidate.kind === "time") {
      checks.push(
        createCheck(
          "error",
          `Pages route ${JSON.stringify(display)} exports REVALIDATE but its effective render ` +
            `mode is ${JSON.stringify(render)}. REVALIDATE is only valid with ` +
            '`RENDER_MODE = "isg"` (or `pagesDefaultRender: "isg"`).',
        ),
      );
    }
  }

  if (scope === "full") {
    checks.push(createCheck("ok", `Found pages directory at ${project.pagesDir}.`));

    if (routes.length === 0) {
      checks.push(createCheck("warning", "Pages router app does not contain any route files yet."));
    } else {
      checks.push(
        createCheck("ok", `Found ${routes.length} page route${routes.length === 1 ? "" : "s"}.`),
      );
    }

    const hasAppShell = pages.some((page) => page.kind === "shell");
    if (!hasAppShell) {
      checks.push(createCheck("warning", "No `_app` shell was found in the pages directory."));
    } else {
      checks.push(createCheck("ok", "Found a pages-router `_app` shell."));
    }

    if (notFoundPages.length === 1) {
      checks.push(createCheck("ok", "Found a pages-router not-found page."));
    }
  } else {
    collectChangedPagesChecks(project, checks, pagesDir, changedFiles);
  }

  // Both scopes: adding a Markdown page and running `verify --changed` is the
  // most likely way to meet this, and a `404.md` breaks the build exactly like
  // a routed one.
  collectMarkdownTransformCheck(
    project,
    checks,
    pages
      .filter((page) => page.kind === "route" || page.kind === "not-found")
      .map((page) => page.file),
  );

  if (notFoundPages.length > 1) {
    checks.push(
      createCheck(
        "error",
        `Pages router resolves multiple not-found pages: ${notFoundPages
          .map((page) => JSON.stringify(displayPath(project.root, page.file)))
          .join(", ")}. Only one file may resolve to "/404".`,
      ),
    );
  }

  if (duplicates.length > 0) {
    checks.push(
      createCheck(
        "error",
        `Pages router resolves duplicate paths: ${duplicates
          .map(
            (entry) =>
              `${JSON.stringify(entry.path)} from ${entry.files.map((file) => JSON.stringify(file)).join(", ")}`,
          )
          .join("; ")}.`,
      ),
    );
  } else if (scope === "full" && routes.length > 0) {
    checks.push(
      createCheck(
        "ok",
        `Pages router resolved ${routes.length} route${routes.length === 1 ? "" : "s"} without path collisions.`,
      ),
    );
  }
}

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

function collectChangedPagesChecks(
  project: ProjectConfig,
  checks: Check[],
  pagesDir: string,
  changedFiles: string[],
): void {
  for (const file of changedFiles) {
    if (!isWithinDirectory(file, pagesDir)) continue;
    if (!PAGE_SOURCE_RE.test(file)) continue;

    const display = displayPath(project.root, file);
    if (!existsSync(file)) {
      checks.push(
        createCheck(
          "ok",
          `Removed page file ${JSON.stringify(display)} is no longer auto-discovered.`,
        ),
      );
      continue;
    }

    const page = describePagesFile(pagesDir, file);
    if (page.kind === "shell") {
      checks.push(
        createCheck(
          "ok",
          `Changed pages shell ${JSON.stringify(display)} will wrap auto-discovered routes.`,
        ),
      );
      continue;
    }

    if (page.kind === "ignored") {
      checks.push(
        createCheck(
          "warning",
          `Changed pages file ${JSON.stringify(display)} is ignored by the pages router.`,
        ),
      );
      continue;
    }

    if (page.kind === "not-found") {
      checks.push(
        createCheck(
          "ok",
          `Changed pages not-found file ${JSON.stringify(display)} is wired automatically.`,
        ),
      );
      continue;
    }

    checks.push(
      createCheck(
        "ok",
        `Changed page route ${JSON.stringify(display)} resolves to ${JSON.stringify(page.routePath)}.`,
      ),
    );
  }
}
