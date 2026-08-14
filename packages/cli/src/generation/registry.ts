import { readFileSync, writeFileSync } from "node:fs";

import { upsertObjectEntry } from "../manifest-edit.js";
import { toManifestModulePath } from "../manifest-path.js";
import {
  assertFileExists,
  displayPath,
  resolveProjectPath,
  resolveScopedFile,
  writeGeneratedFile,
  type ProjectConfig,
} from "../project.js";
import { ensureTrailingNewline, quote } from "../utils.js";
import { buildMiddlewareModuleSource, buildShellModuleSource } from "./registry-source.js";
import type { GenerateResult } from "./types.js";

export function generateShell(name: string, project: ProjectConfig): GenerateResult {
  if (project.mode === "pages") {
    throw new Error(
      "Pages router apps use a single `_app` shell. `pracht generate shell` is only available for manifest apps.",
    );
  }

  const manifestPath = requireManifest(project);
  const shellFile = resolveScopedFile(project.root, project.shellsDir, `${name}.tsx`);
  writeGeneratedFile(shellFile, buildShellModuleSource(name));
  registerModule(project, manifestPath, "shells", name, shellFile);

  return registrationResult(project, "shell", shellFile, manifestPath);
}

export function generateMiddleware(name: string, project: ProjectConfig): GenerateResult {
  if (project.mode === "pages") {
    throw new Error(
      "Pages router apps do not use manifest middleware registration. `pracht generate middleware` is only available for manifest apps.",
    );
  }

  const manifestPath = requireManifest(project);
  const middlewareFile = resolveScopedFile(project.root, project.middlewareDir, `${name}.ts`);
  writeGeneratedFile(middlewareFile, buildMiddlewareModuleSource());
  registerModule(project, manifestPath, "middleware", name, middlewareFile);

  return registrationResult(project, "middleware", middlewareFile, manifestPath);
}

function requireManifest(project: ProjectConfig): string {
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  assertFileExists(manifestPath, `App manifest not found at ${project.appFile}.`);
  return manifestPath;
}

function registerModule(
  project: ProjectConfig,
  manifestPath: string,
  registry: "middleware" | "shells",
  name: string,
  modulePath: string,
): void {
  const manifestSource = readFileSync(manifestPath, "utf-8");
  const updatedSource = upsertObjectEntry(
    manifestSource,
    registry,
    `${name}: ${quote(toManifestModulePath(manifestPath, modulePath))}`,
  );
  writeFileSync(manifestPath, ensureTrailingNewline(updatedSource), "utf-8");
}

function registrationResult(
  project: ProjectConfig,
  kind: "middleware" | "shell",
  modulePath: string,
  manifestPath: string,
): GenerateResult {
  return {
    created: [displayPath(project.root, modulePath)],
    kind,
    updated: [displayPath(project.root, manifestPath)],
  };
}
