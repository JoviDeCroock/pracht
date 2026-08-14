import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { extractCapabilityRegistrations } from "@pracht/capabilities/static";

import { extractRegistryEntries } from "./manifest-read.js";
import { resolveProjectPath, type ProjectConfig } from "./project.js";
import { collectCapabilityContractChecks } from "./verification-capability-contract.js";
import { collectCapabilityProjectionChecks } from "./verification-capability-projections.js";
import { createCheck, type Check } from "./verification-helpers.js";

/**
 * Statically verify registered capabilities in manifest mode. File discovery
 * stays here; individual contracts and graph-wide projections live in focused
 * modules so each verification layer has one reason to change.
 */
export function collectCapabilityChecks(project: ProjectConfig, checks: Check[]): void {
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return;

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const entries = extractCapabilityRegistrations(manifestSource).map(({ name, file }) => ({
    name,
    path: file,
  }));
  if (entries.length === 0) return;

  const registeredMiddleware = new Set(
    extractRegistryEntries(manifestSource, "middleware").map((entry) => entry.name),
  );
  checks.push(
    createCheck(
      "ok",
      `Registered ${entries.length} capabilit${entries.length === 1 ? "y" : "ies"}.`,
    ),
  );

  const manifestDir = dirname(manifestPath);
  const httpExposedNames: string[] = [];
  const mcpExposedNames: string[] = [];

  for (const entry of entries) {
    // Root-relative refs resolve against the project root, matching the
    // runtime registry and Vite plugin. Other refs are manifest-relative.
    const rootRelative = entry.path.startsWith("/");
    const filePath = rootRelative
      ? resolveProjectPath(project.root, entry.path)
      : resolve(manifestDir, entry.path);

    if (!existsSync(filePath)) {
      // The manifest check already reports missing "./"-relative references.
      // Root-relative refs must be reported here or they pass silently.
      if (rootRelative) {
        checks.push(
          createCheck(
            "error",
            `Capability ${JSON.stringify(entry.name)} references missing file ${JSON.stringify(entry.path)}.`,
          ),
        );
      }
      continue;
    }

    const projections = collectCapabilityContractChecks(
      entry.name,
      entry.path,
      readFileSync(filePath, "utf-8"),
      registeredMiddleware,
      checks,
    );
    if (projections.hasValidHttpExposure) {
      httpExposedNames.push(entry.name);
    }
    if (projections.mcpExposed) {
      mcpExposedNames.push(entry.name);
    }
  }

  collectCapabilityProjectionChecks(httpExposedNames, mcpExposedNames, manifestSource, checks);
}
