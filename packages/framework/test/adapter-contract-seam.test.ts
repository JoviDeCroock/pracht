import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Seam guard for the adapter contract in `@pracht/core/adapter`: the shape of
// `dist/server/server.js`, the adapter interface, and the build id have one
// owner. Each rule below fails on the next hand-written copy.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(resolve(repoRoot, dir));
  return files;
}

function offenders(dirs: string[], pattern: RegExp, allowed: string[] = []): string[] {
  const hits: string[] = [];
  for (const file of dirs.flatMap(sources)) {
    const path = relative(repoRoot, file);
    if (allowed.includes(path)) continue;
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${path}:${index + 1}: ${line.trim()}`);
      });
  }
  return hits;
}

const ADAPTER_SOURCES = [
  "packages/adapter-node/src",
  "packages/adapter-cloudflare/src",
  "packages/adapter-netlify/src",
  "packages/adapter-vercel/src",
  "packages/adapter-static/src",
];

describe("adapter contract seam", () => {
  it("adapters take the contract from @pracht/core/adapter, not the Vite plugin", () => {
    expect(offenders(ADAPTER_SOURCES, /from "@pracht\/vite-plugin"/)).toEqual([]);
  });

  it("only the plugin's codegen emits the server entry's contract exports", () => {
    expect(
      offenders(
        [...ADAPTER_SOURCES, "packages/vite-plugin/src", "packages/cli/src"],
        /export const (headersManifestFormat|contract|buildId|adapterId|features) =/,
        ["packages/vite-plugin/src/plugin-codegen.ts"],
      ),
    ).toEqual([]);
  });

  it("the CLI reads the server entry through readServerEntry only", () => {
    expect(
      offenders(
        ["packages/cli/src"],
        /interface \w*(ServerModule|ServerEntry)\w*\b|type \w*(ServerModule|ServerEntry)\w* =|serverMod\.(buildTarget|headersManifestFormat)\b/,
        // The static-export validators' loose view of the same exports, which
        // their tests construct field by field.
        ["packages/cli/src/build-static.ts"],
      ),
    ).toEqual([]);
  });

  it("build identity is the build id, never a timestamp", () => {
    // CF's ISG cache generation once was the prerender's `generatedAt`.
    expect(
      offenders(["packages/adapter-cloudflare/src"], /generatedAt\}?`|\$\{entry\.generatedAt\}/),
    ).toEqual([]);
  });
});
