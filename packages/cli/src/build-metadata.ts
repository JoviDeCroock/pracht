import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST_PATHS = ["dist/client/.vite/manifest.json", "dist/.vite/manifest.json"];

interface ManifestEntry {
  css?: string[];
  file: string;
  imports?: string[];
  src?: string;
}

export function readClientBuildAssets(root = process.cwd()) {
  const manifestPath = MANIFEST_PATHS.map((candidate) => resolve(root, candidate)).find((path) =>
    existsSync(path),
  );

  if (!manifestPath) {
    return {
      clientEntryUrl: null,
      cssManifest: {} as Record<string, string[]>,
      jsManifest: {} as Record<string, string[]>,
    };
  }

  const rawManifest = readFileSync(manifestPath, "utf-8");
  const manifest: Record<string, ManifestEntry> = JSON.parse(rawManifest);
  const clientEntry = manifest["virtual:pracht/client"];

  function collectTransitiveDeps(key: string) {
    const css = new Set<string>();
    const js = new Set<string>();
    const visited = new Set<string>();

    function collect(currentKey: string) {
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
    if (deps.css.length > 0) {
      cssManifest[key] = deps.css.map((file) => `/${file}`);
    }
    if (deps.js.length > 0) {
      jsManifest[key] = deps.js.map((file) => `/${file}`);
    }
  }

  return {
    clientEntryUrl: clientEntry ? `/${clientEntry.file}` : null,
    cssManifest,
    jsManifest,
  };
}
