import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Written next to `package.json` by `scripts/sync-versions.js` at build time. */
export const FALLBACK_VERSIONS_FILE = "fallback-versions.json";

/**
 * `^<version>` for every published `@pracht/*` package in a packages
 * directory, keyed by package name.
 */
export function collectWorkspaceVersionRanges(packagesDir) {
  const ranges = {};
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (manifest.private || !manifest.name?.startsWith("@pracht/") || !manifest.version) continue;
    ranges[manifest.name] = `^${manifest.version}`;
  }
  return Object.fromEntries(Object.entries(ranges).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The `@pracht/*` ranges a scaffold falls back to when the registry lookup
 * fails. Inside the monorepo they come straight from the sibling packages, so
 * a checkout never goes stale; a published copy reads the file its build
 * wrote from those same siblings.
 */
export function loadFallbackVersionRanges(packageRoot) {
  const packagesDir = resolve(packageRoot, "..");
  try {
    const core = JSON.parse(readFileSync(resolve(packagesDir, "framework/package.json"), "utf-8"));
    if (core.name === "@pracht/core") return collectWorkspaceVersionRanges(packagesDir);
  } catch {
    // Not a checkout of the monorepo.
  }
  try {
    return JSON.parse(readFileSync(resolve(packageRoot, FALLBACK_VERSIONS_FILE), "utf-8"));
  } catch {
    return {};
  }
}
