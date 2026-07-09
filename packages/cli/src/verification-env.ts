import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { displayPath, listFilesRecursively, type ProjectConfig } from "./project.js";
import { createCheck, type Check } from "./verification-helpers.js";

// Keep in sync with packages/vite-plugin/src/env-safety.ts — the CLI cannot
// depend on @pracht/vite-plugin, so the (small) scan logic is mirrored here.
const VITE_BUILTIN_ENV_VARS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL", "NODE_ENV"]);
const PUBLIC_ENV_PREFIX = "PRACHT_PUBLIC_";
const VITE_PUBLIC_ENV_PREFIX = "VITE_";
const PUBLIC_ENV_PREFIXES = [PUBLIC_ENV_PREFIX, VITE_PUBLIC_ENV_PREFIX] as const;
const ENV_REFERENCE_RE =
  /\b(process\.env|import\.meta\.env)(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*(["'])([A-Za-z_$][A-Za-z0-9_$]*)\3\s*\])/g;

export interface EnvLeakFinding {
  accessor: string;
  file: string;
  name: string;
}

interface BuildEnvSafetyReport {
  findings?: Array<{ accessor?: unknown; chunk?: unknown; name?: unknown; sources?: unknown }>;
}

export function scanSourceForEnvLeaks(
  code: string,
  allow: ReadonlySet<string>,
): { accessor: string; name: string }[] {
  const findings: { accessor: string; name: string }[] = [];
  const seen = new Set<string>();

  for (const match of code.matchAll(ENV_REFERENCE_RE)) {
    const accessor = match[1];
    const name = match[2] ?? match[4];
    if (!name) continue;
    if (PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (VITE_BUILTIN_ENV_VARS.has(name)) continue;
    if (allow.has(name)) continue;

    const key = `${accessor}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ accessor, name });
  }

  return findings;
}

/**
 * Best-effort extraction of `envSafety: { allow: [...] }` names from the raw
 * vite config source, so verify matches the build-time allowlist.
 */
export function extractEnvSafetyAllowList(rawConfig: string): Set<string> {
  const allow = new Set<string>();
  const envSafetyMatch = rawConfig.match(/envSafety\s*:\s*\{[^}]*allow\s*:\s*\[([^\]]*)\]/);
  if (!envSafetyMatch) return allow;

  for (const entry of envSafetyMatch[1].matchAll(/["']([^"']+)["']/g)) {
    allow.add(entry[1]);
  }
  return allow;
}

function envSafetyDisabled(rawConfig: string): boolean {
  return /envSafety\s*:\s*false/.test(rawConfig);
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
          .map(
            (finding) => `${finding.accessor}.${finding.name} in ${JSON.stringify(finding.file)}`,
          )
          .join("; ")}. Only PRACHT_PUBLIC_- or VITE_-prefixed variables are safe client-side.`,
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
