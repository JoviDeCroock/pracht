import { resolve } from "node:path";

import { displayPath, readProjectConfig } from "./project.js";
import {
  collectApiVerification,
  collectConfigChecks,
  collectManifestVerification,
  collectPackageChecks,
  collectPagesVerification,
} from "./verification-checks.js";
import { createCheck, type Check } from "./verification-helpers.js";
import {
  collectChangedFiles,
  filterFrameworkFiles,
  requiresFullVerification,
} from "./verification-scope.js";

export type { Check } from "./verification-helpers.js";

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
