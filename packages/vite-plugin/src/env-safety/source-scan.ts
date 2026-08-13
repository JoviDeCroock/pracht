import {
  PUBLIC_ENV_PREFIX,
  VITE_BUILTIN_ENV_VARS,
  WHOLE_ENV_READ,
  type EnvLeakReference,
} from "./model.ts";
import { getCodePositionMask } from "./source-mask.ts";

// Matches `process.env.X`, `import.meta.env.X`, their optional-chained forms
// (`import.meta.env?.X`), and the equivalent bracket-string forms
// (`process.env["X"]`, `import.meta.env['X']`).
const ENV_REFERENCE_RE =
  /\b(process\.env|import\.meta\.env)(?:\??\.([A-Za-z_$][A-Za-z0-9_$]*)|(?:\?\.)?\[\s*(["'])([A-Za-z_$][A-Za-z0-9_$]*)\3\s*\])/g;

// Matches `import.meta.env` that is *not* followed by a single-key access, i.e.
// exactly the reads Vite materializes into the full env object.
const WHOLE_ENV_READ_RE = /\bimport\.meta\.env\b(?!\s*\??\.\s*[A-Za-z_$])/g;

/**
 * Scans JavaScript source for references to environment variables that are
 * neither public-prefixed, Vite built-ins, nor explicitly allowed, plus reads
 * that pull in the whole `import.meta.env` object.
 */
export function scanCodeForEnvLeaks(
  code: string,
  allow: ReadonlySet<string> = new Set(),
): EnvLeakReference[] {
  const codePositions = getCodePositionMask(code);
  const matches: Array<{ index: number; reference: EnvLeakReference }> = [];

  for (const match of code.matchAll(ENV_REFERENCE_RE)) {
    const index = match.index ?? -1;
    if (!codePositions[index]) continue;
    const accessor = match[1] as EnvLeakReference["accessor"];
    const name = match[2] ?? match[4];
    if (!name) continue;
    if (name.startsWith(PUBLIC_ENV_PREFIX)) continue;
    if (VITE_BUILTIN_ENV_VARS.has(name)) continue;
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

  const findings: EnvLeakReference[] = [];
  const seen = new Set<string>();
  for (const { reference } of matches.sort((left, right) => left.index - right.index)) {
    const key = `${reference.accessor}.${reference.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(reference);
  }

  return findings;
}
