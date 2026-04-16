import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripPrachtClientModuleQuery } from "./client-module-query.ts";

export const PRACHT_CLIENT_MODULE_ID = "virtual:pracht/client";
export const PRACHT_SERVER_MODULE_ID = "virtual:pracht/server";

// Browser-safe path alias — the colon in "virtual:" is parsed as a protocol
// scheme by browsers, so we serve the client module from a plain path.
export const CLIENT_BROWSER_PATH = "/@pracht/client.js";

export interface ViteManifestEntry {
  file: string;
  src?: string;
  css?: string[];
  imports?: string[];
  dynamicImports?: string[];
}

export interface ClientBuildAssets {
  clientEntryUrl: string | null;
  cssManifest: Record<string, string[]>;
  jsManifest: Record<string, string[]>;
}

export function readClientBuildAssets(root = process.cwd()): ClientBuildAssets {
  const manifestPath = ["dist/client/.vite/manifest.json", "dist/.vite/manifest.json"]
    .map((candidate) => resolve(root, candidate))
    .find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    return { clientEntryUrl: null, cssManifest: {}, jsManifest: {} };
  }

  const rawManifest = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(rawManifest) as Record<string, ViteManifestEntry>;
  const clientEntry = manifest[PRACHT_CLIENT_MODULE_ID];

  const cssManifest: Record<string, string[]> = {};
  const jsManifest: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.src) continue;
    const deps = collectTransitiveDeps(manifest, key);
    const manifestKey = stripPrachtClientModuleQuery(entry.src);
    if (deps.css.length > 0) {
      cssManifest[manifestKey] = deps.css.map((f) => `/${f}`);
    }
    if (deps.js.length > 0) {
      jsManifest[manifestKey] = deps.js.map((f) => `/${f}`);
    }
  }

  return {
    clientEntryUrl: clientEntry ? `/${clientEntry.file}` : null,
    cssManifest,
    jsManifest,
  };
}

// Walk static imports transitively (not dynamicImports — those belong to
// other shells/routes loaded separately). Returns both CSS and JS deps.
function collectTransitiveDeps(
  manifest: Record<string, ViteManifestEntry>,
  key: string,
): { css: string[]; js: string[] } {
  const css = new Set<string>();
  const js = new Set<string>();
  const visited = new Set<string>();

  function collect(k: string): void {
    if (visited.has(k)) return;
    visited.add(k);
    const entry = manifest[k];
    if (!entry) return;
    for (const c of entry.css ?? []) css.add(c);
    js.add(entry.file);
    for (const imp of entry.imports ?? []) collect(imp);
  }

  collect(key);
  return { css: [...css], js: [...js] };
}

export function isClientModule(id: string): boolean {
  return (
    id === PRACHT_CLIENT_MODULE_ID ||
    id === CLIENT_BROWSER_PATH ||
    id.endsWith(PRACHT_CLIENT_MODULE_ID)
  );
}

export function isServerModule(id: string): boolean {
  return id === PRACHT_SERVER_MODULE_ID || id.endsWith(PRACHT_SERVER_MODULE_ID);
}
