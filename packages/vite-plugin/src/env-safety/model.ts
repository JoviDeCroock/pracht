/**
 * Env vars Vite defines on `import.meta.env` in every bundle, plus NODE_ENV
 * which Vite's define pass statically replaces at build time (so it can never
 * leak and is referenced by countless dependencies).
 */
export const VITE_BUILTIN_ENV_VARS = new Set([
  "MODE",
  "DEV",
  "PROD",
  "SSR",
  "BASE_URL",
  "NODE_ENV",
]);

/** Prefix that marks an env var as intentionally public. */
export const PUBLIC_ENV_PREFIX = "PRACHT_PUBLIC_";

/** Server-only core entry that must never resolve into client bundles. */
export const SERVER_ENV_MODULE_ID = "@pracht/core/env/server";

export interface EnvSafetyReport {
  findings: EnvLeakProblem[];
  version: 1;
}

export interface EnvSafetyOptions {
  /** Env var names allowed to appear in client bundles despite not being public. */
  allow?: string[];
}

export interface EnvLeakReference {
  accessor: "process.env" | "import.meta.env";
  name: string;
}

export interface EnvLeakProblem extends EnvLeakReference {
  chunk: string;
  sources: string[];
}

/**
 * Sentinel `name` for an `import.meta.env` read that is not a static single-key
 * access. Vite only narrows `import.meta.env.KEY` / `import.meta.env?.KEY`
 * member expressions to their value; every other read — a bare reference,
 * destructuring, a spread, or bracket access — is replaced by an object literal
 * holding every exposed variable, so the `VITE_` values Pracht treats as
 * non-public end up verbatim in the client bundle. Those reads leave no
 * accessor text behind, so the name-based scan cannot see them.
 */
export const WHOLE_ENV_READ = "*";
