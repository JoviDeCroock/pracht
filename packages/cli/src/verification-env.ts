import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  WHOLE_ENV_READ,
  createCodePositionMask,
  scanEnvironmentReferences,
} from "@pracht/capabilities/static";

import { displayPath, listFilesRecursively, type ProjectConfig } from "./project.js";
import { createCheck, type Check } from "./verification-helpers.js";

export interface EnvLeakFinding {
  accessor: string;
  file: string;
  name: string;
}

interface BuildEnvSafetyReport {
  findings?: Array<{
    accessor?: unknown;
    chunk?: unknown;
    name?: unknown;
    sources?: unknown;
  }>;
}

export function scanSourceForEnvLeaks(
  code: string,
  allow: ReadonlySet<string>,
): { accessor: string; name: string }[] {
  return scanEnvironmentReferences(code, allow);
}

/**
 * Best-effort extraction of `envSafety: { allow: [...] }` names from the raw
 * vite config source, so verify matches the build-time allowlist.
 */
export function extractEnvSafetyAllowList(rawConfig: string): Set<string> {
  const allow = new Set<string>();
  const codePositions = createCodePositionMask(rawConfig);
  const envSafetyPattern = /envSafety\s*:\s*\{[^}]*allow\s*:\s*\[([^\]]*)\]/g;
  const envSafetyMatch = Array.from(rawConfig.matchAll(envSafetyPattern)).find(
    (match) => codePositions[match.index ?? -1],
  );
  if (!envSafetyMatch) return allow;

  for (const entry of envSafetyMatch[1].matchAll(/["']([^"']+)["']/g)) {
    allow.add(entry[1]);
  }
  return allow;
}

function envSafetyDisabled(rawConfig: string): boolean {
  const codePositions = createCodePositionMask(rawConfig);
  return Array.from(rawConfig.matchAll(/envSafety\s*:\s*false/g)).some(
    (match) => codePositions[match.index ?? -1],
  );
}

function readBuildEnvSafetyReport(clientDir: string): EnvLeakFinding[] | null {
  const reportPath = join(clientDir, "_pracht/env-safety.json");
  if (!existsSync(reportPath)) return null;

  let report: BuildEnvSafetyReport;

  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as BuildEnvSafetyReport;
  } catch {
    return null;
  }

  return (report.findings ?? [])
    .filter(
      (finding) =>
        typeof finding.accessor === "string" &&
        typeof finding.chunk === "string" &&
        typeof finding.name === "string",
    )
    .map((finding) => ({
      accessor: finding.accessor as string,
      file: finding.chunk as string,
      name: finding.name as string,
    }));
}

export function collectEnvLeakVerification(
  project: ProjectConfig,
  checks: Check[],
  { scope }: { scope: string },
): void {
  if (scope !== "full") return;

  if (envSafetyDisabled(project.rawConfig)) {
    checks.push(
      createCheck("warning", "Client-bundle env leak detection is disabled (envSafety: false)."),
    );
    return;
  }

  const clientDir = resolve(project.root, "dist/client");
  if (!existsSync(clientDir)) {
    checks.push(
      createCheck(
        "ok",
        "No client build output at dist/client; run `pracht build` to verify env leaks.",
      ),
    );
    return;
  }

  const allow = extractEnvSafetyAllowList(project.rawConfig);
  const buildReportFindings = readBuildEnvSafetyReport(clientDir);
  const findings: EnvLeakFinding[] = buildReportFindings ?? [];

  for (const file of listFilesRecursively(clientDir)) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const code = readFileSync(file, "utf-8");
    for (const finding of scanSourceForEnvLeaks(code, allow)) {
      findings.push({ ...finding, file: displayPath(project.root, file) });
    }
  }

  if (findings.length > 0) {
    checks.push(
      createCheck(
        "error",
        `Client bundle references non-public env vars: ${findings
          .map((finding) => {
            const reference =
              finding.name === WHOLE_ENV_READ
                ? "import.meta.env read as a whole object"
                : `${finding.accessor}.${finding.name}`;
            return `${reference} in ${JSON.stringify(finding.file)}`;
          })
          .join("; ")}. Only PRACHT_PUBLIC_-prefixed variables are safe client-side.`,
      ),
    );
  } else if (!buildReportFindings) {
    checks.push(
      createCheck(
        "warning",
        "No env safety build report found at dist/client/_pracht/env-safety.json; output scan passed, but rebuild with the current Pracht plugin to verify source-level env references.",
      ),
    );
  } else {
    checks.push(createCheck("ok", "Client bundle contains no non-public env var references."));
  }
}
