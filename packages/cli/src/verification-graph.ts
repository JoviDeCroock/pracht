import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { evaluateConstraints } from "@pracht/core";
import type { AppGraphRoute } from "@pracht/core";

import {
  GRAPH_SNAPSHOT_PATH,
  readGraphSnapshotFromDisk,
  resolveLiveGraph,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "./graph-snapshot.js";
import { resolveProjectPath, type ProjectConfig } from "./project.js";
import { createCheck, type Check } from "./verification-helpers.js";

const HEAD_EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const|let|var)\s+head\b|export\s*\{[^}]*\bhead\b[^}]*\}/;

/**
 * Graph-aware verification: enforce `defineApp({ constraints })` and check
 * `.pracht/app-graph.json` freshness. Both need the resolved app graph, so the
 * (comparatively expensive) Vite boot only happens when an app opts in to at
 * least one of them.
 */
export async function collectGraphChecks(project: ProjectConfig, checks: Check[]): Promise<void> {
  const wantsConstraints = manifestDeclaresConstraints(project);
  const snapshotExists = existsSync(resolve(project.root, GRAPH_SNAPSHOT_PATH));
  if (!wantsConstraints && !snapshotExists) return;

  let live: GraphSnapshot;
  try {
    live = await resolveLiveGraph(project.root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(
      createCheck(
        "error",
        `Could not resolve the app graph for constraint/snapshot checks: ${message}`,
      ),
    );
    return;
  }

  collectConstraintChecks(project, live, checks);
  collectSnapshotChecks(project, live, checks, snapshotExists);
}

function collectConstraintChecks(
  project: ProjectConfig,
  live: GraphSnapshot,
  checks: Check[],
): void {
  const constraints = live.constraints;
  if (constraints.length === 0) return;

  const violations = evaluateConstraints(live.routes, constraints, {
    routeHasHead: (route) => routeHasHeadExport(project, route as AppGraphRoute),
  });

  if (violations.length === 0) {
    checks.push(
      createCheck(
        "ok",
        `All ${constraints.length} app constraint${constraints.length === 1 ? "" : "s"} hold across ${live.routes.length} route${live.routes.length === 1 ? "" : "s"}.`,
      ),
    );
    return;
  }

  for (const violation of violations) {
    checks.push(createCheck("error", violation.message));
  }
}

function collectSnapshotChecks(
  project: ProjectConfig,
  live: GraphSnapshot,
  checks: Check[],
  snapshotExists: boolean,
): void {
  if (!snapshotExists) return;

  const snapshot = readGraphSnapshotFromDisk(project.root);
  if (!snapshot) {
    checks.push(
      createCheck(
        "error",
        `${GRAPH_SNAPSHOT_PATH} exists but could not be parsed. Run \`pracht plan --write\` to regenerate it.`,
      ),
    );
    return;
  }

  if (serializeGraphSnapshot(snapshot) === serializeGraphSnapshot(live)) {
    checks.push(createCheck("ok", `App graph snapshot ${GRAPH_SNAPSHOT_PATH} is up to date.`));
  } else {
    checks.push(
      createCheck(
        "error",
        `App graph snapshot ${GRAPH_SNAPSHOT_PATH} is stale. Run \`pracht plan --write\` and commit the result.`,
      ),
    );
  }
}

function manifestDeclaresConstraints(project: ProjectConfig): boolean {
  if (project.mode !== "manifest") return false;
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return false;
  return /\bconstraints\s*:/.test(readFileSync(manifestPath, "utf-8"));
}

/**
 * Whether the route module (or its shell) exports `head()`. Returns undefined
 * when the sources cannot be read, which skips the route.
 */
function routeHasHeadExport(project: ProjectConfig, route: AppGraphRoute): boolean | undefined {
  const routeSource = readModuleSource(project, route.file);
  if (routeSource === null) return undefined;
  if (HEAD_EXPORT_RE.test(routeSource)) return true;

  if (route.shellFile) {
    const shellSource = readModuleSource(project, route.shellFile);
    if (shellSource === null) return undefined;
    return HEAD_EXPORT_RE.test(shellSource);
  }

  return false;
}

function readModuleSource(project: ProjectConfig, file: string): string | null {
  try {
    return readFileSync(resolveModuleFile(project, file), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Manifest module refs are relative to the manifest file ("./routes/home.tsx");
 * pages-router and virtual-module refs are app-absolute ("/src/pages/index.tsx").
 */
function resolveModuleFile(project: ProjectConfig, file: string): string {
  if (file.startsWith("./") || file.startsWith("../")) {
    const manifestPath = resolveProjectPath(project.root, project.appFile);
    return resolve(dirname(manifestPath), file);
  }
  return resolveProjectPath(project.root, file);
}
