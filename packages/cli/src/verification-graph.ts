import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  extractCapabilityRegistrations,
  maskCommentsAndStrings,
} from "@pracht/capabilities/static";
import { evaluateConstraints } from "@pracht/core";
import type { AppGraphRoute } from "@pracht/core";

import {
  GRAPH_SNAPSHOT_PATH,
  readGraphSnapshotFromDisk,
  resolveLiveGraphMetadata,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "./graph-snapshot.js";
import { listFilesRecursively, resolveProjectPath, type ProjectConfig } from "./project.js";
import { detectAdapterTarget } from "./commands/preview.js";
import { createCheck, MODULE_SOURCE_RE, type Check } from "./verification-helpers.js";
import { collectStaticExportChecks } from "./verification-static.js";

const HEAD_EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const|let|var)\s+head\b|export\s*\{[^}]*\bhead\b[^}]*\}/;

/**
 * Graph-aware verification: prove registered API and capability modules load,
 * enforce `defineApp({ constraints })`, and check `.pracht/app-graph.json`
 * freshness. These need the resolved app graph, so the comparatively expensive
 * Vite boot only happens when an app has a live surface to inspect.
 */
export async function collectGraphChecks(project: ProjectConfig, checks: Check[]): Promise<void> {
  const wantsConstraints = manifestDeclaresConstraints(project);
  const wantsCapabilityLoad = manifestDeclaresCapabilities(project);
  const wantsApiLoad = projectDeclaresApiRoutes(project);
  const snapshotExists = existsSync(resolve(project.root, GRAPH_SNAPSHOT_PATH));
  // Raw config inspection is only a gate for the comparatively expensive Vite
  // boot. The resolved metadata below is authoritative: conditional configs,
  // aliases, and custom adapter ids cannot be classified safely from source.
  const mightUseStaticExport = projectMightUseStaticExport(project);
  if (
    !wantsConstraints &&
    !wantsCapabilityLoad &&
    !wantsApiLoad &&
    !snapshotExists &&
    !mightUseStaticExport
  ) {
    return;
  }

  let live: GraphSnapshot;
  let staticTarget = false;
  let loaderRoutePaths: ReadonlySet<string> = new Set();
  try {
    const metadata = await resolveLiveGraphMetadata(project.root);
    live = metadata.graph;
    staticTarget = metadata.staticTarget;
    loaderRoutePaths = metadata.loaderRoutePaths;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(
      createCheck(
        "error",
        `Could not resolve the app graph for live verification checks: ${message}`,
      ),
    );
    return;
  }

  // A source-level candidate can resolve to a serverful adapter (for example
  // an environment-conditional config that merely imports staticAdapter).
  if (
    !wantsConstraints &&
    !wantsCapabilityLoad &&
    !wantsApiLoad &&
    !snapshotExists &&
    !staticTarget
  ) {
    return;
  }

  if (wantsCapabilityLoad) {
    checks.push(
      createCheck(
        "ok",
        `Loaded ${live.capabilities.length} registered capability module${live.capabilities.length === 1 ? "" : "s"} into the app graph.`,
      ),
    );
  }
  if (wantsApiLoad) {
    checks.push(
      createCheck(
        "ok",
        `Loaded ${live.api.length} discovered API route module${live.api.length === 1 ? "" : "s"} into the app graph.`,
      ),
    );
  }
  collectStaticExportChecks(live, checks, { loaderRoutePaths, staticTarget });
  collectConstraintChecks(project, live, checks);
  collectSnapshotChecks(project, live, checks, snapshotExists);
}

function projectMightUseStaticExport(project: ProjectConfig): boolean {
  const detectedTarget = detectAdapterTarget(project);
  if (detectedTarget === "static") return true;

  const maskedConfig = maskCommentsAndStrings(project.rawConfig);
  // A custom adapter can be declared inline rather than imported. Source is
  // only a candidate gate; the resolved `staticTarget` below remains the
  // authoritative answer when this literal belongs to inactive config.
  if (/\bstaticTarget\s*:\s*true\b/.test(maskedConfig)) return true;

  // A local custom adapter can carry `staticTarget: true` outside the Vite
  // config. Inspect direct local imports as a cheap candidate gate; the
  // resolved metadata above remains authoritative.
  if (localConfigImportMightBeStatic(project)) return true;

  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(project.root, "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (
      "@pracht/adapter-static" in (packageJson.dependencies ?? {}) ||
      "@pracht/adapter-static" in (packageJson.devDependencies ?? {})
    ) {
      return true;
    }
  } catch {}

  // An explicit adapter that source inspection cannot classify may come from
  // a third-party package or a local wrapper. Resolve it instead of silently
  // treating the default `node` classification as authoritative. Keep the
  // common built-in Node adapter on the cheap path.
  const configuresAdapter = /\badapter\s*(?::|(?=\s*[,}]))/.test(maskedConfig);
  const isKnownNodeAdapter =
    /\bnodeAdapter\s*\(/.test(maskedConfig) ||
    /^\s*import\s+(?:[^"']+?\s+from\s+)?["']@pracht\/adapter-node["']/m.test(project.rawConfig);
  return detectedTarget === "node" && configuresAdapter && !isKnownNodeAdapter;
}

function localConfigImportMightBeStatic(project: ProjectConfig): boolean {
  if (!project.configFile) return false;

  const importSpecifiers = [
    ...project.rawConfig.matchAll(/^\s*import\s+(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["']/gm),
  ].map((match) => match[1]);

  for (const specifier of importSpecifiers) {
    const unresolvedPath = resolve(dirname(project.configFile), specifier);
    const candidates = [
      unresolvedPath,
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(
        (extension) => `${unresolvedPath}${extension}`,
      ),
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) =>
        resolve(unresolvedPath, `index${extension}`),
      ),
    ];
    const importedFile = candidates.find((candidate) => existsSync(candidate));
    if (!importedFile) continue;

    try {
      if (
        /\bstaticTarget\s*:\s*true\b/.test(
          maskCommentsAndStrings(readFileSync(importedFile, "utf-8")),
        )
      ) {
        return true;
      }
    } catch {
      // A candidate import that cannot be read should not make cheap doctor
      // checks depend on a live Vite boot.
    }
  }

  return false;
}

function projectDeclaresApiRoutes(project: ProjectConfig): boolean {
  const apiDir = resolveProjectPath(project.root, project.apiDir);
  return (
    existsSync(apiDir) && listFilesRecursively(apiDir).some((file) => MODULE_SOURCE_RE.test(file))
  );
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
  if (!snapshotExists) {
    // Reported as `ok` rather than a warning: not having a snapshot is a valid
    // state, it just means `pracht plan` has no baseline to diff against and
    // the staleness guarantee is not in force. Staying silent left new projects
    // with a `.gitignore` that talks about a file nothing ever creates.
    checks.push(
      createCheck(
        "ok",
        `No app graph snapshot yet — run \`pracht plan --write\` and commit ${GRAPH_SNAPSHOT_PATH} ` +
          "to get incremental `pracht plan` diffs and snapshot-staleness verification.",
      ),
    );
    return;
  }

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

function manifestDeclaresCapabilities(project: ProjectConfig): boolean {
  if (project.mode !== "manifest") return false;
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return false;
  const source = readFileSync(manifestPath, "utf-8");
  return extractCapabilityRegistrations(source).length > 0 || /\bcapabilities\s*:/.test(source);
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
