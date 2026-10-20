import { resolve } from "node:path";

import { displayPath, readProjectConfig, resolveProjectPath } from "./project.js";
import {
  collectApiVerification,
  collectBudgetChecks,
  collectConfigChecks,
  collectManifestVerification,
  collectPackageChecks,
  collectPagesVerification,
  collectTypeScriptConfigChecks,
} from "./verification-checks.js";
import { collectCapabilityChecks } from "./verification-capabilities.js";
import { collectEnvLeakVerification } from "./verification-env.js";
import {
  collectGraphChecks,
  tryResolveLiveGraph,
  type LiveGraphResult,
} from "./verification-graph.js";
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

export async function runDoctor(root: string): Promise<DoctorReport> {
  const report = await runVerification(root);

  return {
    checks: report.checks,
    configFile: report.configFile,
    mode: report.mode,
    ok: report.ok,
  };
}

export async function runVerification(
  root: string,
  options: { changed?: boolean } = {},
): Promise<VerificationReport> {
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

  // A manifest app is checked against the graph dev and build resolve, so a
  // manifest split across modules or a constraint held in a variable is seen.
  // When the graph cannot be resolved, the manifest checks read the pracht
  // plugin's static facts about the manifest instead, and the failure itself
  // is reported below.
  let liveGraph: LiveGraphResult | undefined;
  if (project.mode === "pages") {
    collectPagesVerification(project, checks, { changedFiles: frameworkFiles, scope });
  } else {
    liveGraph = await tryResolveLiveGraph(
      project.root,
      resolveProjectPath(project.root, project.appFile),
    );
    collectManifestVerification(project, checks, {
      changedFiles: frameworkFiles,
      scope,
      manifest: "metadata" in liveGraph ? liveGraph.metadata.manifest : liveGraph.manifest,
    });
  }

  // Capability contracts are cheap to verify statically and security relevant,
  // so they are always checked — in pages mode against the same facts the
  // generated manifest is built from. No-op for apps with no capabilities and
  // no agent config.
  collectCapabilityChecks(project, checks);

  collectApiVerification(project, checks, { changedFiles: frameworkFiles, scope });
  collectEnvLeakVerification(project, checks, { scope });
  collectPackageChecks(project, checks, packageJsonPath);
  collectTypeScriptConfigChecks(project, checks);
  collectBudgetChecks(project, checks);
  await collectGraphChecks(project, checks, liveGraph);

  // A graph that dev and build cannot resolve either (an unknown shell, a
  // throwing manifest) must not pass silently behind the text fallback. It is
  // a warning, not an error, because the same failure also covers apps whose
  // dependencies are not installed, which verified green before.
  const graphFailureReported = checks.some((check) =>
    check.message.startsWith("Could not resolve the app graph"),
  );
  if (liveGraph && "error" in liveGraph && !graphFailureReported) {
    checks.push(
      createCheck(
        "warning",
        `Could not resolve the app graph, so the manifest checks read ${project.appFile} ` +
          `statically and constraints were not evaluated: ${liveGraph.error}`,
      ),
    );
  }

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
