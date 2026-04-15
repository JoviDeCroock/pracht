import { execFileSync } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { extractRegistryEntries, extractRelativeModulePaths } from "./manifest.js";
import {
  displayPath,
  hasPagesAppShell,
  listFilesRecursively,
  readProjectConfig,
  resolveProjectPath,
  type ProjectConfig,
} from "./project.js";

const CONFIG_FILE_NAMES = new Set([
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.cts",
]);

const MODULE_SOURCE_RE = /\.(ts|tsx|js|jsx)$/;
const PAGE_SOURCE_RE = /\.(ts|tsx|js|jsx|md|mdx)$/;

export interface Check {
  message: string;
  status: "ok" | "warning" | "error";
}

export interface DoctorReport {
  checks: Check[];
  configFile: string | null;
  mode: "manifest" | "pages";
  ok: boolean;
}

export interface VerificationReport {
  changedFiles: string[];
  checks: Check[];
  configFile: string | null;
  frameworkFiles: string[];
  mode: "manifest" | "pages";
  ok: boolean;
  requestedScope: string;
  scope: string;
}

export function runDoctor(root: string): DoctorReport {
  const report = runVerification(root);

  return {
    checks: report.checks,
    configFile: report.configFile,
    mode: report.mode,
    ok: report.ok,
  };
}

export function runVerification(
  root: string,
  options: { changed?: boolean } = {},
): VerificationReport {
  const project = readProjectConfig(root);
  const checks: Check[] = [];
  const packageJsonPath = resolve(project.root, "package.json");
  const configDisplayPath = project.configFile
    ? displayPath(root, project.configFile)
    : "vite.config.*";
  const requestedScope = options.changed ? "changed" : "full";

  collectConfigChecks(project, checks, configDisplayPath);

  let changedInfo: { files: string[]; warning: string | null } = {
    files: [],
    warning: null,
  };

  if (options.changed) {
    changedInfo = collectChangedFiles(project.root);
    if (changedInfo.warning) {
      checks.push(createCheck("warning", changedInfo.warning));
    }
  }

  const frameworkFiles = options.changed
    ? filterFrameworkFiles(project, changedInfo.files, packageJsonPath)
    : [];
  const scope =
    options.changed && !changedInfo.warning && !requiresFullVerification(project, frameworkFiles)
      ? "changed"
      : "full";

  if (project.mode === "pages") {
    collectPagesVerification(project, checks, { changedFiles: frameworkFiles, scope });
  } else {
    collectManifestVerification(project, checks, { changedFiles: frameworkFiles, scope });
  }

  collectApiVerification(project, checks, { changedFiles: frameworkFiles, scope });
  collectPackageChecks(project, checks, packageJsonPath);

  if (options.changed && frameworkFiles.length === 0 && !changedInfo.warning) {
    checks.push(
      createCheck("ok", "No changed framework files were detected in the current project scope."),
    );
  }

  return {
    checks,
    configFile: project.configFile ? displayPath(root, project.configFile) : null,
    mode: project.mode,
    ok: !checks.some((check) => check.status === "error"),
    requestedScope,
    scope,
    changedFiles: changedInfo.files.map((file) => displayPath(project.root, file)),
    frameworkFiles: frameworkFiles.map((file) => displayPath(project.root, file)),
  };
}

function collectConfigChecks(
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
}

function collectManifestVerification(
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
    { dir: resolveProjectPath(project.root, project.routesDir), label: "route module" },
    { dir: resolveProjectPath(project.root, project.shellsDir), label: "shell module" },
    { dir: resolveProjectPath(project.root, project.middlewareDir), label: "middleware module" },
    { dir: resolveProjectPath(project.root, project.serverDir), label: "server module" },
  ];

  for (const file of changedFiles) {
    const directory = moduleDirectories.find((entry) => isWithinDirectory(file, entry.dir));
    if (!directory) continue;
    if (!MODULE_SOURCE_RE.test(file)) continue;

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

function collectPagesVerification(
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
  const duplicates = collectDuplicateRoutePaths(routes as PagesRoute[]).map((entry) => ({
    ...entry,
    files: entry.files.map((file) => displayPath(project.root, file)),
  }));

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
  } else {
    collectChangedPagesChecks(project, checks, pagesDir, changedFiles);
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

    checks.push(
      createCheck(
        "ok",
        `Changed page route ${JSON.stringify(display)} resolves to ${JSON.stringify(page.routePath)}.`,
      ),
    );
  }
}

function collectApiVerification(
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

function collectPackageChecks(
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
}

function collectChangedFiles(root: string): { files: string[]; warning: string | null } {
  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    const output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const files = new Set<string>();

    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const record = line.slice(3);
      if (!record) continue;

      if (record.includes(" -> ")) {
        const [from, to] = record.split(" -> ");
        addChangedFile(files, repoRoot, prefix, from);
        addChangedFile(files, repoRoot, prefix, to);
      } else {
        addChangedFile(files, repoRoot, prefix, record);
      }
    }

    return {
      files: [...files],
      warning: null,
    };
  } catch {
    return {
      files: [],
      warning: "Unable to determine changed files from git; ran full verification instead.",
    };
  }
}

function addChangedFile(
  files: Set<string>,
  repoRoot: string,
  prefix: string,
  repoRelativePath: string,
): void {
  if (prefix && !repoRelativePath.startsWith(prefix)) {
    return;
  }

  const projectRelativePath = prefix ? repoRelativePath.slice(prefix.length) : repoRelativePath;
  if (!projectRelativePath) {
    return;
  }

  files.add(resolve(repoRoot, projectRelativePath));
}

function filterFrameworkFiles(
  project: ProjectConfig,
  files: string[],
  packageJsonPath: string,
): string[] {
  const appFile = resolveProjectPath(project.root, project.appFile);
  const routesDir = resolveProjectPath(project.root, project.routesDir);
  const shellsDir = resolveProjectPath(project.root, project.shellsDir);
  const middlewareDir = resolveProjectPath(project.root, project.middlewareDir);
  const serverDir = resolveProjectPath(project.root, project.serverDir);
  const apiDir = resolveProjectPath(project.root, project.apiDir);
  const pagesDir = project.pagesDir ? resolveProjectPath(project.root, project.pagesDir) : null;

  return files.filter((file) => {
    if (CONFIG_FILE_NAMES.has(basename(file))) return true;
    if (normalizePath(file) === normalizePath(packageJsonPath)) return true;
    if (project.mode === "manifest" && normalizePath(file) === normalizePath(appFile)) return true;
    if (isWithinDirectory(file, routesDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (isWithinDirectory(file, shellsDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (isWithinDirectory(file, middlewareDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (isWithinDirectory(file, serverDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (isWithinDirectory(file, apiDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (pagesDir && isWithinDirectory(file, pagesDir) && PAGE_SOURCE_RE.test(file)) return true;
    return false;
  });
}

function requiresFullVerification(project: ProjectConfig, changedFiles: string[]): boolean {
  const packageJsonPath = resolve(project.root, "package.json");
  const appFile = resolveProjectPath(project.root, project.appFile);

  return changedFiles.some((file) => {
    const normalized = normalizePath(file);
    if (CONFIG_FILE_NAMES.has(basename(file))) return true;
    if (normalized === normalizePath(packageJsonPath)) return true;
    if (project.mode === "manifest" && normalized === normalizePath(appFile)) return true;
    return false;
  });
}

type PagesFile = { file: string; kind: "shell" } | { file: string; kind: "ignored" } | PagesRoute;

interface PagesRoute {
  file: string;
  kind: "route";
  routePath: string;
}

function scanPagesDirectory(pagesDir: string): PagesFile[] {
  return listFilesRecursively(pagesDir)
    .filter((file) => PAGE_SOURCE_RE.test(file))
    .map((file) => describePagesFile(pagesDir, file));
}

function describePagesFile(pagesDir: string, file: string): PagesFile {
  const relativePath = relative(pagesDir, file).replace(/\\/g, "/");
  const routePath = relativePath.replace(/\.(tsx?|jsx?|mdx?)$/, "");
  const name = basename(routePath);

  if (hasPagesAppShell(file)) {
    return { file, kind: "shell" };
  }

  if (name.startsWith("_")) {
    return { file, kind: "ignored" };
  }

  if (routePath === "index") {
    return { file, kind: "route", routePath: "/" };
  }

  const withoutIndex = routePath.replace(/\/index$/, "");
  const normalized = withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, "*")
    .replace(/\[([^\].]+)\]/g, ":$1");

  return {
    file,
    kind: "route",
    routePath: normalizeRoutePath(`/${normalized}`),
  };
}

function collectDuplicateRoutePaths(routes: PagesRoute[]): { files: string[]; path: string }[] {
  const routeMap = new Map<string, string[]>();

  for (const route of routes) {
    const files = routeMap.get(route.routePath) ?? [];
    files.push(route.file);
    routeMap.set(route.routePath, files);
  }

  return [...routeMap.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([path, files]) => ({ files, path }));
}

function resolveApiRoutePath(apiDir: string, file: string): string {
  let relativePath = relative(apiDir, file).replace(/\\/g, "/");
  relativePath = relativePath.replace(/\.(ts|tsx|js|jsx)$/, "");

  if (relativePath === "index") {
    relativePath = "";
  } else {
    relativePath = relativePath.replace(/\/index$/, "");
  }

  relativePath = relativePath.replace(/\[([^\]]+)\]/g, ":$1");

  return normalizeRoutePath(relativePath ? `/api/${relativePath}` : "/api");
}

function toModuleSpecifier(fromDir: string, filePath: string): string {
  const relativePath = relative(fromDir, filePath).replace(/\\/g, "/");
  if (relativePath.startsWith(".")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

function normalizeRoutePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

function isWithinDirectory(filePath: string, directoryPath: string): boolean {
  const relativePath = relative(directoryPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("../"));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function createCheck(status: Check["status"], message: string): Check {
  return { message, status };
}
