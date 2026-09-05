import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readClientBuildAssets } from "../src/plugin-assets.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.length = 0;
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-inline-css-"));
  roots.push(root);
  mkdirSync(join(root, "dist/client/.vite"), { recursive: true });
  mkdirSync(join(root, "dist/client/assets"), { recursive: true });
  writeFileSync(join(root, "dist/client/assets/home.css"), ".home{color:purple}");
  writeFileSync(
    join(root, "dist/client/.vite/manifest.json"),
    JSON.stringify({
      "src/routes/home.tsx": {
        file: "assets/home.js",
        src: "src/routes/home.tsx",
        css: ["assets/home.css"],
      },
    }),
  );
  return root;
}

describe("readClientBuildAssets inlineCss", () => {
  it("leaves CSS content out by default", () => {
    const assets = readClientBuildAssets(fixture(), "/app/");
    expect(assets.cssManifest["src/routes/home.tsx"]).toEqual(["/app/assets/home.css"]);
    expect(assets.cssContentManifest).toEqual({});
  });

  it("keys emitted CSS content by its public base-prefixed URL", () => {
    const assets = readClientBuildAssets(fixture(), "/app/", true);
    expect(assets.cssContentManifest).toEqual({
      "/app/assets/home.css": ".home{color:purple}",
    });
  });
});
