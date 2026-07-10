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
  const codePositions = getCodePositionMask(code);

  for (const match of code.matchAll(ENV_REFERENCE_RE)) {
    if (!codePositions[match.index ?? -1]) continue;
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

function getCodePositionMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  const templateExpressionDepths: number[] = [];
  let mode: "block-comment" | "code" | "double" | "line-comment" | "regex" | "single" | "template" =
    "code";
  let regexCharClass = false;
  let i = 0;

  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];

    if (mode === "line-comment") {
      if (char === "\n" || char === "\r") {
        mode = "code";
        mask[i] = 1;
      }
      i++;
      continue;
    }

    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === quote || char === "\n" || char === "\r") {
        mode = "code";
      }
      i++;
      continue;
    }

    if (mode === "regex") {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "[") {
        regexCharClass = true;
        i++;
        continue;
      }
      if (char === "]") {
        regexCharClass = false;
        i++;
        continue;
      }
      if (char === "/" && !regexCharClass) {
        regexCharClass = false;
        i++;
        while (i < code.length && isIdentifierChar(code[i])) i++;
        mode = "code";
        continue;
      }
      if (char === "\n" || char === "\r") {
        regexCharClass = false;
        mode = "code";
      }
      i++;
      continue;
    }

    if (mode === "template") {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "`") {
        mode = "code";
        i++;
        continue;
      }
      if (char === "$" && next === "{") {
        mask[i] = 1;
        mask[i + 1] = 1;
        templateExpressionDepths.push(1);
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    mask[i] = 1;

    if (char === "/" && next === "/") {
      mask[i + 1] = 1;
      mode = "line-comment";
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      mask[i + 1] = 1;
      mode = "block-comment";
      i += 2;
      continue;
    }

    if (char === "/" && isRegexLiteralStart(code, i)) {
      mode = "regex";
      regexCharClass = false;
      i++;
      continue;
    }

    if (char === "'") {
      mode = "single";
      i++;
      continue;
    }

    if (char === '"') {
      mode = "double";
      i++;
      continue;
    }

    if (char === "`") {
      mode = "template";
      i++;
      continue;
    }

    if (templateExpressionDepths.length > 0) {
      const top = templateExpressionDepths.length - 1;
      if (char === "{") {
        templateExpressionDepths[top]++;
      } else if (char === "}") {
        templateExpressionDepths[top]--;
        if (templateExpressionDepths[top] === 0) {
          templateExpressionDepths.pop();
          mode = "template";
        }
      }
    }

    i++;
  }

  return mask;
}

function isRegexLiteralStart(code: string, slashIndex: number): boolean {
  let i = slashIndex - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return true;

  const previous = code[i];
  if (previous === ">" && code[i - 1] === "=") return true;
  if ("([{=,:;!?&|^~<>*%+-".includes(previous)) return true;

  if (isIdentifierChar(previous)) {
    let start = i;
    while (start >= 0 && isIdentifierChar(code[start])) start--;
    const word = code.slice(start + 1, i + 1);
    return new Set([
      "await",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "of",
      "return",
      "throw",
      "typeof",
      "void",
      "yield",
    ]).has(word);
  }

  return false;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

/**
 * Best-effort extraction of `envSafety: { allow: [...] }` names from the raw
 * vite config source, so verify matches the build-time allowlist.
 */
export function extractEnvSafetyAllowList(rawConfig: string): Set<string> {
  const allow = new Set<string>();
  const codePositions = getCodePositionMask(rawConfig);
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
  const codePositions = getCodePositionMask(rawConfig);
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
