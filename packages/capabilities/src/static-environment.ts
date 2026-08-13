import { createCodePositionMask } from "./static-code-mask.ts";

/** Environment names Vite defines or replaces safely in every bundle. */
export const VITE_BUILTIN_ENV_NAMES = new Set([
  "MODE",
  "DEV",
  "PROD",
  "SSR",
  "BASE_URL",
  "NODE_ENV",
]);

/** Prefix that marks an environment variable as intentionally public. */
export const PRACHT_PUBLIC_ENV_PREFIX = "PRACHT_PUBLIC_";

/** Sentinel for a read that causes Vite to materialize the whole environment object. */
export const WHOLE_ENV_READ = "*";

export interface EnvironmentReference {
  accessor: "process.env" | "import.meta.env";
  name: string;
}

// Static dot/optional-chain access and equivalent string-bracket forms.
const ENV_REFERENCE_RE =
  /\b(process\.env|import\.meta\.env)(?:\??\.([A-Za-z_$][A-Za-z0-9_$]*)|(?:\?\.)?\[\s*(["'])([A-Za-z_$][A-Za-z0-9_$]*)\3\s*\])/g;

// Reads that are not a single-key access. Vite materializes every exposed
// environment variable at these sites.
const WHOLE_ENV_READ_RE = /\bimport\.meta\.env\b(?!\s*\??\.\s*[A-Za-z_$])/g;

/**
 * Find non-public environment references in executable JavaScript source.
 *
 * The same policy drives the Vite client-build guard and CLI build verifier so
 * a source is never accepted by one framework surface and rejected by another.
 */
export function scanEnvironmentReferences(
  code: string,
  allow: ReadonlySet<string> = new Set(),
): EnvironmentReference[] {
  const codePositions = createCodePositionMask(code);
  const matches: Array<{ index: number; reference: EnvironmentReference }> = [];

  for (const match of code.matchAll(ENV_REFERENCE_RE)) {
    const index = match.index ?? -1;
    if (!codePositions[index]) continue;
    const accessor = match[1] as EnvironmentReference["accessor"];
    const name = match[2] ?? match[4];
    if (!name) continue;
    if (name.startsWith(PRACHT_PUBLIC_ENV_PREFIX)) continue;
    if (VITE_BUILTIN_ENV_NAMES.has(name)) continue;
    if (allow.has(name)) continue;
    matches.push({ index, reference: { accessor, name } });
  }

  if (!allow.has(WHOLE_ENV_READ)) {
    for (const match of code.matchAll(WHOLE_ENV_READ_RE)) {
      const index = match.index ?? -1;
      if (!codePositions[index]) continue;
      matches.push({ index, reference: { accessor: "import.meta.env", name: WHOLE_ENV_READ } });
    }
  }

  const findings: EnvironmentReference[] = [];
  const seen = new Set<string>();
  for (const { reference } of matches.sort((left, right) => left.index - right.index)) {
    const key = `${reference.accessor}.${reference.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(reference);
  }
  return findings;
}
