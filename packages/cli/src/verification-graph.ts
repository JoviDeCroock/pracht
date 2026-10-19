import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  extractDefineAppObjectBody,
  extractCapabilityRegistrations,
  maskCommentsAndStrings,
  scanTopLevelProperties,
} from "@pracht/capabilities/static";
import { evaluateConstraints, matchRoutePath } from "@pracht/core";
import type { Plugin } from "vite";

import { readPluginManifestFacts } from "./app-server.js";
import {
  GRAPH_SNAPSHOT_PATH,
  manifestModuleFactsFromPlugin,
  readGraphSnapshotFromDisk,
  resolveLiveGraphMetadata,
  serializeGraphSnapshot,
  type GraphSnapshot,
  type LiveGraphMetadata,
  type ManifestModuleFacts,
} from "./graph-snapshot.js";
import { listFilesRecursively, resolveProjectPath, type ProjectConfig } from "./project.js";
import { detectAdapterTarget } from "./commands/preview.js";
import { collectMcpServingChecks } from "./verification-capabilities.js";
import { createCheck, isModuleSource, type Check } from "./verification-helpers.js";
import { collectStaticExportChecks } from "./verification-static.js";

/**
 * A live graph resolution attempt that callers can share across checks. A
 * failed one still carries the pracht plugin's static manifest facts when the
 * Vite config itself loaded.
 */
export type LiveGraphResult =
  | { metadata: LiveGraphMetadata }
  | { error: string; manifest?: ManifestModuleFacts };

export async function tryResolveLiveGraph(root: string): Promise<LiveGraphResult> {
  let plugins: readonly Plugin[] | undefined;
  try {
    return {
      metadata: await resolveLiveGraphMetadata(root, {
        onServer: (server) => (plugins = server.config.plugins),
      }),
    };
  } catch (error) {
    const facts = plugins ? readPluginManifestFacts(plugins) : null;
    return {
      error: error instanceof Error ? error.message : String(error),
      ...(facts ? { manifest: manifestModuleFactsFromPlugin(facts) } : {}),
    };
  }
}

/**
 * Graph-aware verification: prove registered API and capability modules load,
 * enforce `defineApp({ constraints })`, and check `.pracht/app-graph.json`
 * freshness. These need the resolved app graph. Manifest apps resolve it up
 * front (`resolved`); otherwise the comparatively expensive Vite boot only
 * happens when an app has a live surface to inspect.
 */
export async function collectGraphChecks(
  project: ProjectConfig,
  checks: Check[],
  resolved?: LiveGraphResult,
): Promise<void> {
  const wantsConstraints =
    manifestDeclaresConstraints(project) ||
    (resolved !== undefined &&
      "metadata" in resolved &&
      resolved.metadata.graph.constraints.length > 0);
  const wantsCapabilityLoad = manifestDeclaresCapabilities(project);
  const wantsAgentValidation = manifestDeclaresAgents(project);
  const wantsApiLoad = projectDeclaresApiRoutes(project);
  const snapshotExists = existsSync(resolve(project.root, GRAPH_SNAPSHOT_PATH));
  // Raw config inspection is only a gate for the comparatively expensive Vite
  // boot. The resolved metadata below is authoritative: conditional configs,
  // aliases, and custom adapter ids cannot be classified safely from source.
  const mightUseStaticExport = projectMightUseStaticExport(project);
  if (
    !wantsConstraints &&
    !wantsCapabilityLoad &&
    !wantsAgentValidation &&
    !wantsApiLoad &&
    !snapshotExists &&
    !mightUseStaticExport
  ) {
    return;
  }

  let live: GraphSnapshot;
  let staticTarget = false;
  let loaderRoutePaths: ReadonlySet<string> = new Set();
  const result = resolved ?? (await tryResolveLiveGraph(project.root));
  if ("error" in result) {
    checks.push(
      createCheck(
        "error",
        `Could not resolve the app graph for live verification checks: ${result.error}`,
      ),
    );
    return;
  }
  live = result.metadata.graph;
  staticTarget = result.metadata.staticTarget;
  loaderRoutePaths = result.metadata.loaderRoutePaths;

  // A source-level candidate can resolve to a serverful adapter (for example
  // an environment-conditional config that merely imports staticAdapter).
  if (
    !wantsConstraints &&
    !wantsCapabilityLoad &&
    !wantsAgentValidation &&
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
  if (wantsCapabilityLoad) collectMcpServingChecks(live, checks, project);
  collectMcpRouteCollisionChecks(live, checks);
  collectWebmcpRouteChecks(live, checks);
  collectStaticExportChecks(live, checks, { loaderRoutePaths, staticTarget });
  collectConstraintChecks(live, checks, result.metadata.headlessRoutePaths);
  collectSnapshotChecks(project, live, checks, snapshotExists);
}

/** Every route declaration must point at a capability eligible for WebMCP. */
export function collectWebmcpRouteChecks(live: GraphSnapshot, checks: Check[]): void {
  const byName = new Map(live.capabilities.map((capability) => [capability.name, capability]));
  const active = new Set<string>();
  let invalid = 0;

  for (const route of live.routes) {
    for (const name of route.capabilities ?? []) {
      active.add(name);
      const capability = byName.get(name);
      if (!capability?.transports.includes("webmcp")) {
        invalid += 1;
        checks.push(
          createCheck(
            "error",
            `Route ${JSON.stringify(route.path)} activates capability ${JSON.stringify(name)} as ` +
              "a page tool, but that capability does not set expose.webmcp with expose.http.",
          ),
        );
      }
    }
  }

  for (const capability of live.capabilities) {
    if (!capability.transports.includes("webmcp") || active.has(capability.name)) continue;
    checks.push(
      createCheck(
        "warning",
        `Capability ${JSON.stringify(capability.name)} sets expose.webmcp but no route activates ` +
          "it. Add the capability name to a route's capabilities list (or export CAPABILITIES from a pages route).",
      ),
    );
  }

  if (active.size > 0 && invalid === 0) {
    checks.push(
      createCheck(
        "ok",
        `Resolved ${active.size} route-scoped WebMCP page tool${active.size === 1 ? "" : "s"}.`,
      ),
    );
  }
}

/** Explicit API dispatch must not shadow the remote MCP security boundary. */
export function collectMcpRouteCollisionChecks(live: GraphSnapshot, checks: Check[]): void {
  if (live.mcpEndpoint === null) return;
  const endpoint = normalizeEndpointPath(live.mcpEndpoint);
  const collisions = live.api.filter(
    (route) => matchRoutePath(normalizeEndpointPath(route.path), endpoint) !== null,
  );
  for (const route of collisions) {
    checks.push(
      createCheck(
        "error",
        `API route ${JSON.stringify(route.path)} collides with agents.mcp.path. Move one of them; ` +
          "an API route must not shadow the remote MCP endpoint's transport and authentication gates.",
      ),
    );
  }
}

function normalizeEndpointPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
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
  // common direct built-in Node adapter call on the cheap path. Quoted keys
  // are checked in raw source because string masking necessarily erases them;
  // a false-positive candidate only causes the authoritative Vite resolution.
  const configuresAdapter =
    /\badapter\s*(?::|(?=\s*[,}]))/.test(maskedConfig) ||
    /["']adapter["']\s*:/.test(project.rawConfig);
  const isKnownNodeAdapter = /\badapter\s*:\s*nodeAdapter\s*\(/.test(maskedConfig);
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
  return existsSync(apiDir) && listFilesRecursively(apiDir).some((file) => isModuleSource(file));
}

function collectConstraintChecks(
  live: GraphSnapshot,
  checks: Check[],
  headlessRoutePaths: ReadonlySet<string>,
): void {
  const constraints = live.constraints;
  if (constraints.length === 0) return;

  // The build's own head hints decide it: a route with no `head()`, in its
  // module or its shell, is one the hints marked headless.
  const violations = evaluateConstraints(live.routes, constraints, {
    routeHasHead: (route) => !headlessRoutePaths.has(route.path),
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
  if (project.mode === "pages") {
    // Modules under capabilitiesDir are registered without any page export.
    const capabilitiesDir = resolveProjectPath(project.root, project.capabilitiesDir);
    if (existsSync(capabilitiesDir) && listFilesRecursively(capabilitiesDir).some(isModuleSource)) {
      return true;
    }
    const pagesDir = resolveProjectPath(project.root, project.pagesDir);
    return (
      existsSync(pagesDir) &&
      listFilesRecursively(pagesDir).some(
        (file) =>
          isModuleSource(file) &&
          /\bexport\s+const\s+CAPABILITIES\b/.test(
            maskCommentsAndStrings(readFileSync(file, "utf-8")),
          ),
      )
    );
  }
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return false;
  const source = readFileSync(manifestPath, "utf-8");
  return extractCapabilityRegistrations(source).length > 0 || /\bcapabilities\s*:/.test(source);
}

function manifestDeclaresAgents(project: ProjectConfig): boolean {
  if (project.mode !== "manifest") return false;
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return false;
  const appBody = extractDefineAppObjectBody(readFileSync(manifestPath, "utf-8"));
  return (
    appBody !== null &&
    (scanTopLevelProperties(appBody).has("agents") ||
      /\bagents\b/.test(maskCommentsAndStrings(appBody)))
  );
}
