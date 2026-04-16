import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

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
  MODULE_SOURCE_RE,
  PAGE_SOURCE_RE,
  normalizePath,
  resolveApiRoutePath,
  toModuleSpecifier,
  type Check,
} from "./verification-helpers.js";
import {
  collectDuplicateRoutePaths,
  describePagesFile,
  scanPagesDirectory,
  type PagesRoute,
} from "./verification-pages.js";

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
}
