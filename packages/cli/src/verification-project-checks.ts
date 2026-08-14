/** Budget, package metadata, and deployment configuration verification. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { formatBytes } from "./bundle-report.js";
import { detectAdapterTarget } from "./commands/preview.js";
import { extractRegistryEntries } from "./manifest-read.js";
import {
  displayPath,
  listFilesRecursively,
  resolveProjectPath,
  type ProjectConfig,
} from "./project.js";
import {
  createCheck,
  MODULE_SOURCE_RE,
  normalizePath,
  type Check,
} from "./verification-helpers.js";
import {
  findWranglerConfig,
  readWranglerAssetsHtmlHandling,
  readWranglerMainEntries,
} from "./wrangler-config.js";

const SERVER_ENTRY_PATH = "dist/server/server.js";

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
 * fails to resolve at request time and capability metadata appears private or
 * unknown in development and inspection surfaces.
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
 * `dist/server/server.js` exports build metadata in addition to the request
 * handler. Workerd validates every named export and rejects that module as a
 * Worker entry, so Cloudflare deployments must point at the generated
 * `dist/server/worker.js`. Detection remains warning-only because adapter and
 * Wrangler configuration discovery are conservative heuristics.
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
 * Cloudflare's default asset handling redirects clean paths to trailing-slash
 * URLs, unlike the Node and Vercel adapters. Warn for apps with prerendered
 * routes when `assets.html_handling` is omitted, but stay silent whenever the
 * configuration or prerender evidence is uncertain.
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

/** Prefer build output, then conservatively infer prerendering from source modes. */
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
    ? listFilesRecursively(sourceDir).filter((file) => MODULE_SOURCE_RE.test(file))
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
