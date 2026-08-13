import type { EnvironmentReference } from "@pracht/capabilities/static";

export {
  PRACHT_PUBLIC_ENV_PREFIX as PUBLIC_ENV_PREFIX,
  VITE_BUILTIN_ENV_NAMES as VITE_BUILTIN_ENV_VARS,
  WHOLE_ENV_READ,
} from "@pracht/capabilities/static";

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

export type EnvLeakReference = EnvironmentReference;

export interface EnvLeakProblem extends EnvLeakReference {
  chunk: string;
  sources: string[];
}
