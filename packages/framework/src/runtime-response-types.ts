import type { ModuleRegistry } from "./types.ts";

/** Shared generated-asset and diagnostics options used by runtime error views. */
export interface RuntimeResponseOptions {
  debugErrors?: boolean;
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  registry?: ModuleRegistry;
}
