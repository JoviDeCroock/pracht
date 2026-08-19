import { dirname, extname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

import { formatBytes } from "./bundle-report.js";
import { hasNamedMiddlewareExport } from "@pracht/capabilities/static";
import { parseAst } from "vite";

import { extractRegistryEntries, extractRelativeModulePaths } from "./manifest.js";
import {
  displayPath,
  listFilesRecursively,
  resolveProjectPath,
  type ProjectConfig,
} from "./project.js";
import {
  createCheck,
  isWithinDirectory,
  isPageSource,
  isRouteSource,
  MODULE_SOURCE_RE,
  normalizePath,
  resolveApiRoutePath,
  toModuleSpecifier,
  type Check,
} from "./verification-helpers.js";
import { detectAdapterTarget } from "./commands/preview.js";
import {
  findWranglerConfig,
  readWranglerAssetsHtmlHandling,
  readWranglerMainEntries,
} from "./wrangler-config.js";
import {
  collectDuplicateRoutePaths,
  describePagesFile,
  scanPagesDirectory,
  type PagesFile,
  type PagesRoute,
} from "./verification-pages.js";

const SERVER_ENTRY_PATH = "dist/server/server.js";

export function collectConfigChecks(
  project: ProjectConfig,
  checks: Check[],
  configDisplayPath: string,
): void {
  if (!project.configFile) {
    checks.push(createCheck("error", "Missing vite config."));
  } else {
    checks.push(createCheck("ok", `Found ${configDisplayPath}.`));
  }

  if (!project.hasPrachtPlugin) {
    checks.push(createCheck("error", "vite.config does not appear to register the pracht plugin."));
  } else {
    checks.push(createCheck("ok", "Vite config registers the pracht plugin."));
  }

  if (!project.additionalExtensionsIsStatic) {
    checks.push(
      createCheck(
        "warning",
        "additionalExtensions could not be resolved statically. The live Vite configuration " +
          "still controls builds, but static route verification cannot classify custom-format " +
          "files reliably. Use an inline string array or a const string array when possible.",
      ),
    );
  }
}

export function collectManifestVerification(
  project: ProjectConfig,
  checks: Check[],
  { changedFiles, scope }: { changedFiles: string[]; scope: string },
): void {
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) {
    checks.push(createCheck("error", `App manifest is missing at ${project.appFile}.`));
    return;
  }

  const source = readFileSync(manifestPath, "utf-8");
  const relativeModules = [...extractRelativeModulePaths(source)];
  const routeCount = (source.match(/\broute\s*\(/g) ?? []).length;

  if (scope === "full") {
    checks.push(createCheck("ok", `Found app manifest at ${project.appFile}.`));

    if (routeCount === 0) {
      checks.push(createCheck("warning", "No routes were found in the app manifest."));
    } else {
      checks.push(
        createCheck(
          "ok",
          `App manifest defines ${routeCount} route${routeCount === 1 ? "" : "s"}.`,
        ),
      );
    }

    const shellEntries = extractRegistryEntries(source, "shells");
    const middlewareEntries = extractRegistryEntries(source, "middleware");

    if (shellEntries.length > 0) {
      checks.push(
        createCheck(
          "ok",
          `Registered ${shellEntries.length} shell${shellEntries.length === 1 ? "" : "s"}.`,
        ),
      );
    }

    if (middlewareEntries.length > 0) {
      checks.push(
        createCheck(
          "ok",
          `Registered ${middlewareEntries.length} middleware module${middlewareEntries.length === 1 ? "" : "s"}.`,
        ),
      );
      collectMiddlewareExportChecks(checks, manifestPath, middlewareEntries);
    }

    const missingModules = relativeModules
      .map((modulePath) => ({
        display: modulePath,
        exists: existsSync(resolve(dirname(manifestPath), modulePath)),
      }))
      .filter((entry) => !entry.exists)
      .map((entry) => entry.display);

    if (missingModules.length > 0) {
      checks.push(
        createCheck(
          "error",
          `Manifest references missing files: ${missingModules.map((item) => JSON.stringify(item)).join(", ")}.`,
        ),
      );
    } else {
      checks.push(
        createCheck(
          "ok",
          `All ${relativeModules.length} manifest module path${relativeModules.length === 1 ? "" : "s"} resolve.`,
        ),
      );
    }
  } else {
    collectChangedManifestModuleChecks(
      project,
      checks,
      manifestPath,
      relativeModules,
      changedFiles,
    );
  }

  // `.md` / `.mdx` are valid manifest route modules and break exactly the same
  // way a pages-router Markdown page does.
  collectMarkdownTransformCheck(
    project,
    checks,
    relativeModules.map((modulePath) => resolve(dirname(manifestPath), modulePath)),
  );
}

type MiddlewareParserLanguage = "js" | "jsx" | "ts" | "tsx";

/** Whether `source` statically exposes a runtime binding named `middleware`. */
export function exportsMiddleware(source: string, file = "middleware.ts"): boolean {
  try {
    return hasNamedMiddlewareExport(parseAst(source, { lang: middlewareParserLanguage(file) }));
  } catch {
    return false;
  }
}

function middlewareParserLanguage(file: string): MiddlewareParserLanguage {
  switch (extname(file).toLowerCase()) {
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".tsx":
      return "tsx";
    default:
      return "ts";
  }
}

/**
 * A registered middleware module that does not export `middleware` used to be
 * skipped at runtime, so an auth gate could be wired in the manifest and
 * absent in production while every check here passed. The runtime now refuses
 * to serve such a route; this check reports the same mistake before a request
 * ever reaches it.
 */
function collectMiddlewareExportChecks(
  checks: Check[],
  manifestPath: string,
  entries: { name: string; path: string }[],
): void {
  const manifestDir = dirname(manifestPath);
  const missing: string[] = [];

  for (const entry of entries) {
    const file = resolve(manifestDir, entry.path);
    if (!existsSync(file)) continue; // already reported by the module-path check
    if (!exportsMiddleware(readFileSync(file, "utf-8"), file)) {
      missing.push(`${entry.name} (${entry.path})`);
    }
  }

  if (missing.length === 0) {
    checks.push(
      createCheck("ok", `All ${entries.length} middleware module(s) export \`middleware\`.`),
    );
    return;
  }

  checks.push(
    createCheck(
      "error",
      `Middleware module(s) without a \`middleware\` export: ${missing.join(", ")}. ` +
        "Middleware must `export const middleware: MiddlewareFn = (args, next) => …` " +
        "(a default export is not used); routes referencing them fail at request time.",
    ),
  );
}

function collectChangedManifestModuleChecks(
  project: ProjectConfig,
  checks: Check[],
  manifestPath: string,
  relativeModules: string[],
  changedFiles: string[],
): void {
  const manifestDir = dirname(manifestPath);
  const referencedModules = new Set(relativeModules.map(normalizePath));
  const moduleDirectories = [
    {
      additionalExtensions: true,
      dir: resolveProjectPath(project.root, project.routesDir),
      label: "route module",
    },
    {
      additionalExtensions: true,
      dir: resolveProjectPath(project.root, project.shellsDir),
      label: "shell module",
    },
    {
      additionalExtensions: false,
      dir: resolveProjectPath(project.root, project.middlewareDir),
      label: "middleware module",
    },
    {
      additionalExtensions: false,
      dir: resolveProjectPath(project.root, project.serverDir),
      label: "server module",
    },
  ];

  for (const file of changedFiles) {
    const directory = moduleDirectories.find((entry) => isWithinDirectory(file, entry.dir));
    if (!directory) continue;
    if (
      !(directory.additionalExtensions
        ? isRouteSource(file, project.additionalExtensions)
        : MODULE_SOURCE_RE.test(file))
    )
      continue;

    const display = displayPath(project.root, file);
    const modulePath = normalizePath(toModuleSpecifier(manifestDir, file));
    const exists = existsSync(file);

    if (referencedModules.has(modulePath)) {
      if (exists) {
        checks.push(
          createCheck(
            "ok",
            `Changed ${directory.label} ${JSON.stringify(display)} is referenced by the app manifest.`,
          ),
        );
      } else {
        checks.push(
          createCheck(
            "error",
            `Changed ${directory.label} ${JSON.stringify(display)} was removed but is still referenced by the app manifest.`,
          ),
        );
      }
      continue;
    }

    if (exists) {
      checks.push(
        createCheck(
          "warning",
          `Changed ${directory.label} ${JSON.stringify(display)} is not referenced by the app manifest.`,
        ),
      );
    }
  }
}

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

  const pages = scanPagesDirectory(pagesDir, project.additionalExtensions);
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

  collectPagesMiddlewareChecks(project, checks, pages, scope);

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

/**
 * Pages middleware mirrors the build's rules: exactly one root-level
 * `_middleware.{ts,tsx,js,jsx}` that exports `middleware`. A nested file and a
 * missing export are both fail-open shapes — the file looks like an auth gate
 * while the build ignores it or the runtime refuses to serve — so they are
 * errors in both scopes, exactly like the REVALIDATE checks above.
 */
function collectPagesMiddlewareChecks(
  project: ProjectConfig,
  checks: Check[],
  pages: PagesFile[],
  scope: string,
): void {
  const middlewareFiles = pages.filter((page) => page.kind === "middleware");
  const directoryShaped = middlewareFiles.filter((page) => page.shape === "directory");
  const unsupportedExtension = middlewareFiles.filter(
    (page) => page.shape === "unsupported-extension",
  );
  const nested = middlewareFiles.filter((page) => page.shape === "file" && page.nested);
  const rootFiles = middlewareFiles.filter((page) => page.shape === "file" && !page.nested);

  for (const page of directoryShaped) {
    checks.push(
      createCheck(
        "error",
        `A \`_middleware\` directory is not supported (${JSON.stringify(displayPath(project.root, page.file))}). ` +
          "Pages middleware is a single root-level `_middleware.ts` file in the pages directory " +
          "(it runs on every page route). Move the logic there, or eject to an explicit " +
          "manifest for per-group middleware.",
      ),
    );
  }

  for (const page of unsupportedExtension) {
    const extension = extname(page.file);
    checks.push(
      createCheck(
        "error",
        `Pages middleware ${JSON.stringify(displayPath(project.root, page.file))} cannot use the ` +
          `\`${extension}\` extension. The middleware registry loads ` +
          "`.ts`, `.tsx`, `.js`, and `.jsx` modules only — rename the file to `_middleware.ts`.",
      ),
    );
  }

  for (const page of nested) {
    checks.push(
      createCheck(
        "error",
        `Nested pages middleware ${JSON.stringify(displayPath(project.root, page.file))} is not ` +
          "supported. Only a root-level `_middleware.ts` in the pages directory is applied (it " +
          "runs on every page route). Move the logic there, or eject to an explicit manifest " +
          "for per-group middleware.",
      ),
    );
  }

  if (rootFiles.length > 1) {
    checks.push(
      createCheck(
        "error",
        `Multiple pages middleware files resolve to the same registration: ${rootFiles
          .map((page) => JSON.stringify(displayPath(project.root, page.file)))
          .join(", ")}. Keep exactly one root-level \`_middleware\` file.`,
      ),
    );
    return;
  }

  const middleware = rootFiles[0];
  if (!middleware) return;

  if (!exportsMiddleware(readFileSync(middleware.file, "utf-8"), middleware.file)) {
    checks.push(
      createCheck(
        "error",
        `Pages middleware ${JSON.stringify(displayPath(project.root, middleware.file))} does not ` +
          "export `middleware`. It must `export const middleware: MiddlewareFn = (args, next) " +
          "=> …` (a default export is not used); page routes fail at request time.",
      ),
    );
    return;
  }

  if (scope === "full") {
    checks.push(
      createCheck(
        "ok",
        "Found pages middleware `_middleware`; it runs on every page route (API routes are " +
          "not wrapped).",
      ),
    );
  }
}

const MARKDOWN_PAGE_RE = /\.(?:mdx?|markdown)$/;
// Plugin specifiers that transform Markdown/MDX into a renderable module,
// matched against the raw vite config text. Necessarily a heuristic: a custom
// or re-exported plugin is invisible here, which is why this warns and says so
// rather than asserting the app is broken.
const MARKDOWN_PLUGIN_HINTS = ["@mdx-js/rollup", "vite-plugin-mdx", "vite-plugin-markdown"];
// `prachtContent()` transforms only the sources its collections actually
// register, which this text scan cannot determine, so its presence softens the
// warning rather than silencing it. `pracht build` does resolve the registry
// and reports the routes no collection owns.
const CONTENT_REGISTRY_HINT = "@pracht/content/vite";

/**
 * A `.md`, `.markdown`, or `.mdx` route is registered like any other, but nothing renders it
 * unless a transform plugin is configured: Vite hands the raw Markdown to the
 * JS parser, so the route 500s at request time with `Invalid Character` and
 * `pracht build` fails with a raw parser stack. Both `doctor` and `verify`
 * would otherwise report the app healthy.
 */
function collectMarkdownTransformCheck(
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

  const summary =
    `${markdownFiles.length} Markdown route${markdownFiles.length === 1 ? "" : "s"} ` +
    `(${shown}${markdownFiles.length > 3 ? ", ..." : ""})`;

  checks.push(
    createCheck(
      "warning",
      config.includes(CONTENT_REGISTRY_HINT)
        ? `${summary} with \`prachtContent()\` configured. Static verification cannot tell ` +
            "whether its collections register these sources, and Pracht does not otherwise " +
            "transform Markdown: any route no collection owns reaches Vite's JS parser and " +
            "fails at request and build time. `pracht build` resolves the registry and reports them."
        : `${summary} but no known Markdown transform plugin in the vite config. Pracht does ` +
            "not transform Markdown: without a plugin such as `@mdx-js/rollup` registered " +
            "alongside `pracht()`, Vite hands the raw source to the JS parser and these routes " +
            "fail at request and build time. Ignore this if you register a custom or " +
            "re-exported Markdown plugin.",
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
    if (!isPageSource(file, project.additionalExtensions)) continue;

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

    const page = describePagesFile(pagesDir, file, project.additionalExtensions);
    if (page.kind === "shell") {
      checks.push(
        createCheck(
          "ok",
          `Changed pages shell ${JSON.stringify(display)} will wrap auto-discovered routes.`,
        ),
      );
      continue;
    }

    if (page.kind === "middleware") {
      // Broken shapes (nested files, `_middleware/` directories, `.tsrx`) are
      // reported as errors by the middleware checks that run in every scope;
      // only the working shape gets an ok here.
      if (page.shape === "file" && !page.nested) {
        checks.push(
          createCheck(
            "ok",
            `Changed pages middleware ${JSON.stringify(display)} runs on every page route.`,
          ),
        );
      }
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

export function collectApiVerification(
  project: ProjectConfig,
  checks: Check[],
  { changedFiles, scope }: { changedFiles: string[]; scope: string },
): void {
  const apiDir = resolveProjectPath(project.root, project.apiDir);
  const changedApiFiles = changedFiles.filter((file) => isWithinDirectory(file, apiDir));
  if (scope === "changed" && changedApiFiles.length === 0) {
    return;
  }

  if (!existsSync(apiDir)) {
    if (scope === "full") {
      checks.push(
        createCheck(
          "ok",
          `No API directory was found at ${project.apiDir}; skipping API discovery.`,
        ),
      );
    }
    return;
  }

  const apiFiles = listFilesRecursively(apiDir).filter((file) => MODULE_SOURCE_RE.test(file));
  const routeMap = new Map<string, string[]>();

  for (const file of apiFiles) {
    const routePath = resolveApiRoutePath(apiDir, file);
    const display = displayPath(project.root, file);
    const entries = routeMap.get(routePath) ?? [];
    entries.push(display);
    routeMap.set(routePath, entries);
  }

  const duplicates = [...routeMap.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([path, files]) => ({ files, path }));

  if (duplicates.length > 0) {
    checks.push(
      createCheck(
        "error",
        `API route discovery resolves duplicate paths: ${duplicates
          .map(
            (entry) =>
              `${JSON.stringify(entry.path)} from ${entry.files.map((file) => JSON.stringify(file)).join(", ")}`,
          )
          .join("; ")}.`,
      ),
    );
  } else if (scope === "full") {
    checks.push(
      createCheck(
        "ok",
        `API route discovery resolved ${apiFiles.length} route${apiFiles.length === 1 ? "" : "s"}.`,
      ),
    );
  }

  for (const file of changedApiFiles) {
    if (!MODULE_SOURCE_RE.test(file)) continue;

    const display = displayPath(project.root, file);
    if (!existsSync(file)) {
      checks.push(
        createCheck(
          "ok",
          `Removed API route ${JSON.stringify(display)} is no longer auto-discovered.`,
        ),
      );
      continue;
    }

    checks.push(
      createCheck(
        "ok",
        `Changed API route ${JSON.stringify(display)} resolves to ${JSON.stringify(resolveApiRoutePath(apiDir, file))}.`,
      ),
    );
  }
}

interface BudgetReportFile {
  results?: {
    path: string;
    gzipBytes: number;
    limitBytes: number;
    ok: boolean;
  }[];
}

export function collectBudgetChecks(project: ProjectConfig, checks: Check[]): void {
  const reportPath = resolve(project.root, "dist/server/budget-report.json");
  if (!existsSync(reportPath)) return;

  let report: BudgetReportFile;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8"));
  } catch {
    checks.push(
      createCheck("warning", "dist/server/budget-report.json exists but could not be parsed."),
    );
    return;
  }

  const results = report.results ?? [];
  if (results.length === 0) return;

  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    checks.push(
      createCheck(
        "ok",
        `All ${results.length} route client JS budget${results.length === 1 ? "" : "s"} pass (from the last \`pracht build\`).`,
      ),
    );
    return;
  }

  for (const result of failed) {
    checks.push(
      createCheck(
        "error",
        `Route ${JSON.stringify(result.path)} exceeds its client JS budget: ${formatBytes(result.gzipBytes)} gzip > ${formatBytes(result.limitBytes)} (from the last \`pracht build\`).`,
      ),
    );
  }
}

export function collectPackageChecks(
  project: ProjectConfig,
  checks: Check[],
  packageJsonPath: string,
): void {
  if (!existsSync(packageJsonPath)) {
    checks.push(createCheck("warning", "No package.json found in the current app root."));
    return;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  const deps: Record<string, string> = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  if (!("@pracht/cli" in deps)) {
    checks.push(
      createCheck("warning", "`@pracht/cli` is not listed in package.json dependencies."),
    );
  }

  const adapterPackages = Object.keys(deps).filter((name) => name.startsWith("@pracht/adapter-"));
  if (adapterPackages.length === 0) {
    checks.push(
      createCheck("warning", "No built-in pracht adapter dependency was found in package.json."),
    );
  } else {
    checks.push(
      createCheck(
        "ok",
        `Found adapter dependency ${adapterPackages.map((name) => JSON.stringify(name)).join(", ")}.`,
      ),
    );
  }

  collectCapabilitiesDependencyCheck(project, deps, checks);
  collectCloudflareEntryCheck(project, dirname(packageJsonPath), checks);
}

/**
 * Capability modules import `defineCapability` from `@pracht/capabilities`,
 * which is a separate package the app has to install. Without it the registry
 * fails to resolve at request time (`internal_error`) and — more confusingly —
 * every capability's metadata reads as unknown, so the dev banner and
 * `pracht inspect capabilities` report exposed capabilities as `private` with
 * no effect class.
 */
function collectCapabilitiesDependencyCheck(
  project: ProjectConfig,
  deps: Record<string, string>,
  checks: Check[],
): void {
  if (project.mode !== "manifest") return;

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return;
  const entries = extractRegistryEntries(readFileSync(manifestPath, "utf-8"), "capabilities");
  if (entries.length === 0) return;

  if ("@pracht/capabilities" in deps) {
    checks.push(createCheck("ok", 'Found capability dependency "@pracht/capabilities".'));
    return;
  }

  checks.push(
    createCheck(
      "error",
      "The app registers capabilities but `@pracht/capabilities` is not in package.json. " +
        "Install it (`npm install @pracht/capabilities`) — without it capability dispatch " +
        "answers 500 at runtime and capability metadata reads as private/unknown in the dev " +
        "banner and `pracht inspect capabilities`.",
    ),
  );
}

/**
 * `dist/server/server.js` also exports the build metadata the CLI's prerender
 * pass needs (buildTarget, manifests, the resolved app, ...). workerd validates
 * every named export of the deployed entry module and refuses to start when one
 * of them is not a handler, so pointing `main` at it fails at `wrangler dev` /
 * `wrangler deploy` time with an opaque type error. `pracht build` writes
 * `dist/server/worker.js` for exactly this reason.
 *
 * Reported as a warning, and only ever about an entry that was actually read.
 * Two things here are heuristics — which adapter the vite config resolves to
 * (a text match) and which `main` entries a wrangler config declares (a
 * conservative reader that skips shapes it does not recognize) — so this must
 * not be able to fail a build. It stays silent when nothing is provably wrong
 * rather than claiming the config is fine: "no entries read" means unknown,
 * not correct.
 */
function collectCloudflareEntryCheck(project: ProjectConfig, root: string, checks: Check[]): void {
  if (detectAdapterTarget(project) !== "cloudflare") return;

  const configFile = findWranglerConfig(root);
  if (!configFile) return;

  const display = displayPath(root, configFile);
  collectCloudflareTrailingSlashCheck(project, root, configFile, display, checks);

  for (const entry of readWranglerMainEntries(configFile)) {
    if (!normalizePath(entry.main).endsWith(SERVER_ENTRY_PATH)) continue;

    const where = entry.environment ? ` for environment "${entry.environment}"` : "";
    checks.push(
      createCheck(
        "warning",
        `${display} sets "main"${where} to ${JSON.stringify(entry.main)}. ` +
          'Point it at "dist/server/worker.js" — the deploy entry `pracht build` emits. ' +
          "workerd rejects server.js because it also exports build metadata that is not a Worker handler.",
      ),
    );
  }
}

/**
 * Cloudflare's assets binding defaults to `html_handling: "auto-trailing-slash"`,
 * which answers `GET /guide` with a 307 to `/guide/`. Node and Vercel answer
 * `200`, so the canonical URL of every prerendered route differs by adapter —
 * and the generated `llms.txt` emits the non-slash form, sending agents through
 * a redirect on Cloudflare only.
 *
 * `create-pracht` writes `"drop-trailing-slash"` into new Cloudflare scaffolds;
 * this catches the apps that predate it. Warning-only and silent whenever
 * anything is unproven: a TOML config, an unparsable file, no assets block, or
 * an app with nothing prerendered to redirect.
 */
function collectCloudflareTrailingSlashCheck(
  project: ProjectConfig,
  root: string,
  configFile: string,
  display: string,
  checks: Check[],
): void {
  const assets = readWranglerAssetsHtmlHandling(configFile);
  if (!assets || assets.htmlHandling !== undefined) return;
  if (!appHasPrerenderedRoutes(project, root)) return;

  checks.push(
    createCheck(
      "warning",
      `${display} does not set "assets.html_handling". Cloudflare's default redirects ` +
        "every prerendered route to its trailing-slash form (307), so its canonical URL " +
        'differs from Node and Vercel. Add "html_handling": "drop-trailing-slash" ' +
        '(or "none" when you do your own routing).',
    ),
  );
}

/**
 * Whether the app plausibly emits prerendered HTML. Proven from build output
 * when there is any, and otherwise inferred from declared render modes — the
 * same text-level heuristic the surrounding Cloudflare checks already accept,
 * because the only consequence of being wrong is a suppressed suggestion.
 */
function appHasPrerenderedRoutes(project: ProjectConfig, root: string): boolean {
  const clientDir = resolve(root, "dist/client");
  if (existsSync(clientDir)) {
    return listFilesRecursively(clientDir).some((file) => file.endsWith(".html"));
  }

  const sourceDir =
    project.mode === "manifest"
      ? resolveProjectPath(project.root, project.appFile)
      : resolveProjectPath(project.root, project.pagesDir);
  if (!existsSync(sourceDir)) return false;

  const files = statSync(sourceDir).isDirectory()
    ? listFilesRecursively(sourceDir).filter((file) =>
        project.mode === "pages"
          ? isPageSource(file, project.additionalExtensions)
          : isRouteSource(file, project.additionalExtensions),
      )
    : [sourceDir];

  return files.some((file) => {
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      return false;
    }
    return /["']ssg["']|["']isg["']/.test(source);
  });
}
