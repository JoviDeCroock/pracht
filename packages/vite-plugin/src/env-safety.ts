/**
 * Public environment-safety entry point.
 *
 * Keep this facade stable while source parsing, diagnostics, and Vite lifecycle
 * integration evolve independently.
 */
export { formatEnvLeakError } from "./env-safety/diagnostics.ts";
export {
  PUBLIC_ENV_PREFIX,
  SERVER_ENV_MODULE_ID,
  VITE_BUILTIN_ENV_VARS,
  WHOLE_ENV_READ,
  type EnvLeakReference,
  type EnvSafetyOptions,
  type EnvSafetyReport,
} from "./env-safety/model.ts";
export { createEnvSafetyPlugin } from "./env-safety/plugin.ts";
export { scanCodeForEnvLeaks } from "./env-safety/source-scan.ts";
