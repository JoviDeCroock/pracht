import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLIENT_MANIFEST_PATH,
  readClientBuildAssets,
  relocateClientManifest,
} from "../src/build-metadata.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createBuiltRoot(): { root: string; clientDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pracht-build-metadata-"));
  roots.push(root);
  const clientDir = join(root, "dist/client");
  mkdirSync(join(clientDir, ".vite"), { recursive: true });
  writeFileSync(
    join(clientDir, ".vite/manifest.json"),
    JSON.stringify({ "virtual:pracht/client": { file: "assets/client-abc.js" } }),
  );
  return { root, clientDir };
}

describe("relocateClientManifest", () => {
  it("moves the Vite manifest out of the deployed client directory", () => {
    const { root, clientDir } = createBuiltRoot();

    relocateClientManifest(root, clientDir);

    expect(existsSync(join(clientDir, ".vite"))).toBe(false);
    expect(existsSync(join(root, CLIENT_MANIFEST_PATH))).toBe(true);
    // Introspection after the build still finds it.
    expect(readClientBuildAssets(root).clientEntryUrl).toBe("/assets/client-abc.js");
  });

  it("is a no-op without a manifest, and keeps a directory something else wrote to", () => {
    const { root, clientDir } = createBuiltRoot();
    writeFileSync(join(clientDir, ".vite/other.json"), "{}");

    relocateClientManifest(root, clientDir);
    relocateClientManifest(root, clientDir);

    expect(existsSync(join(clientDir, ".vite/other.json"))).toBe(true);
    expect(existsSync(join(clientDir, ".vite/manifest.json"))).toBe(false);
  });

  it("prefers a manifest at Vite's own location over a relocated one", () => {
    const { root, clientDir } = createBuiltRoot();
    mkdirSync(join(root, "dist/server/.vite"), { recursive: true });
    writeFileSync(
      join(root, CLIENT_MANIFEST_PATH),
      JSON.stringify({ "virtual:pracht/client": { file: "assets/client-stale.js" } }),
    );

    expect(readClientBuildAssets(root).clientEntryUrl).toBe("/assets/client-abc.js");
    relocateClientManifest(root, clientDir);
    expect(readClientBuildAssets(root).clientEntryUrl).toBe("/assets/client-abc.js");
  });
});
