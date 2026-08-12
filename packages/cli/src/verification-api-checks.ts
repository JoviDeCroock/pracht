/** File-system API route discovery verification. */

import { existsSync } from "node:fs";

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
  resolveApiRoutePath,
  type Check,
} from "./verification-helpers.js";

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
