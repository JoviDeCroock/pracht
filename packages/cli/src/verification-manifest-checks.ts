import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { exportsMiddleware } from "./middleware-export-source.js";

import { extractRegistryEntries, extractRelativeModulePaths } from "./manifest.js";
import { displayPath, resolveProjectPath, type ProjectConfig } from "./project.js";
import {
  createCheck,
  isWithinDirectory,
  MODULE_SOURCE_RE,
  normalizePath,
  toModuleSpecifier,
  type Check,
} from "./verification-helpers.js";
import { collectMarkdownTransformCheck } from "./verification-markdown-checks.js";

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
    if (!exportsMiddleware(readFileSync(file, "utf-8"))) {
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
