import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

import { resolveProjectPath, type ProjectConfig } from "./project.js";
import {
  CONFIG_FILE_NAMES,
  MODULE_SOURCE_RE,
  isWithinDirectory,
  isPageSource,
  isRouteSource,
  normalizePath,
} from "./verification-helpers.js";

export function collectChangedFiles(root: string): { files: string[]; warning: string | null } {
  // stderr silenced throughout: outside a git repo these print `fatal: not a
  // git repository` straight to the user's terminal, ahead of the warning below
  // that explains the situation properly.
  const git = {
    encoding: "utf-8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
  };

  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      ...git,
    }).trim();
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: root,
      ...git,
    }).trim();
    const output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      ...git,
    });
    const files = new Set<string>();

    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const record = line.slice(3);
      if (!record) continue;

      if (record.includes(" -> ")) {
        const [from, to] = record.split(" -> ");
        addChangedFile(files, root, prefix, from);
        addChangedFile(files, root, prefix, to);
      } else {
        addChangedFile(files, root, prefix, record);
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
  projectRoot: string,
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

  files.add(resolve(projectRoot, projectRelativePath));
}

export function filterFrameworkFiles(
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
    if (
      isWithinDirectory(file, routesDir) &&
      (!project.additionalExtensionsIsStatic || isRouteSource(file, project.additionalExtensions))
    )
      return true;
    if (
      isWithinDirectory(file, shellsDir) &&
      (!project.additionalExtensionsIsStatic || isRouteSource(file, project.additionalExtensions))
    )
      return true;
    if (isWithinDirectory(file, middlewareDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (isWithinDirectory(file, serverDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (isWithinDirectory(file, apiDir) && MODULE_SOURCE_RE.test(file)) return true;
    if (
      pagesDir &&
      isWithinDirectory(file, pagesDir) &&
      (!project.additionalExtensionsIsStatic || isPageSource(file, project.additionalExtensions))
    )
      return true;
    return false;
  });
}

export function requiresFullVerification(project: ProjectConfig, changedFiles: string[]): boolean {
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
