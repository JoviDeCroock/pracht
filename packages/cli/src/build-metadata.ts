import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST_PATHS = ["dist/client/.vite/manifest.json", "dist/.vite/manifest.json"];
const PRACHT_CLIENT_MODULE_QUERY = "pracht-client";

interface ViteManifestEntry {
  css?: string[];
  file: string;
  imports?: string[];
  src?: string;
}

export interface ClientBuildAssets {
  clientEntryUrl: string | null;
  cssManifest: Record<string, string[]>;
  jsManifest: Record<string, string[]>;
}

export function readClientBuildAssets(root: string = process.cwd()): ClientBuildAssets {
  const manifestPath = MANIFEST_PATHS.map((candidate) => resolve(root, candidate)).find((path) =>
    existsSync(path),
  );

  if (!manifestPath) {
    return {
      clientEntryUrl: null,
      cssManifest: {},
      jsManifest: {},
    };
  }

  const rawManifest = readFileSync(manifestPath, "utf-8");
  const manifest: Record<string, ViteManifestEntry> = JSON.parse(rawManifest);
  const clientEntry = manifest["virtual:pracht/client"];

  function collectTransitiveDeps(key: string): { css: string[]; js: string[] } {
    const css = new Set<string>();
    const js = new Set<string>();
    const visited = new Set<string>();

    function collect(currentKey: string): void {
      if (visited.has(currentKey)) return;
      visited.add(currentKey);

      const entry = manifest[currentKey];
      if (!entry) return;

      for (const cssFile of entry.css ?? []) {
        css.add(cssFile);
      }

      js.add(entry.file);

      for (const importedKey of entry.imports ?? []) {
        collect(importedKey);
      }
    }

    collect(key);
    return {
      css: [...css],
      js: [...js],
    };
  }

  const cssManifest: Record<string, string[]> = {};
  const jsManifest: Record<string, string[]> = {};

  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.src) continue;

    const deps = collectTransitiveDeps(key);
    const manifestKey = stripPrachtClientModuleQuery(entry.src);
    if (deps.css.length > 0) {
      cssManifest[manifestKey] = deps.css.map((file) => `/${file}`);
    }
    if (deps.js.length > 0) {
      jsManifest[manifestKey] = deps.js.map((file) => `/${file}`);
    }
  }

  return {
    clientEntryUrl: clientEntry ? `/${clientEntry.file}` : null,
    cssManifest,
    jsManifest,
  };
}

function stripPrachtClientModuleQuery(id: string): string {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return id;

  const path = id.slice(0, queryStart);
  const query = id
    .slice(queryStart + 1)
    .split("&")
    .filter((part) => part !== PRACHT_CLIENT_MODULE_QUERY);

  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}
