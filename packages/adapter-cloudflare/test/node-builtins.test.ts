import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cloudflareAdapter } from "../src/index.ts";

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-cf-builtins-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  return root;
}

function builtins(root: string, configPath?: string): string[] {
  return [...(cloudflareAdapter({ configPath }).edgeNodeBuiltins?.(root) ?? [])];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloudflareAdapter edgeNodeBuiltins", () => {
  it.each(["nodejs_als", "nodejs_compat"])("provides node:async_hooks under %s", (flag) => {
    const root = project({
      "wrangler.jsonc": `{
        "$schema": "https://example.com//schema.json", // a URL is not a comment
        /* block */ "compatibility_flags": ["${flag}",],
      }`,
    });

    expect(builtins(root)).toEqual(["node:async_hooks"]);
  });

  it("reads the configured config file instead of the default lookup", () => {
    const root = project({
      "wrangler.jsonc": '{ "compatibility_flags": [] }',
      ".void-wrangler.jsonc": '{ "compatibility_flags": ["nodejs_als"] }',
    });

    expect(builtins(root)).toEqual([]);
    expect(builtins(root, "./.void-wrangler.jsonc")).toEqual(["node:async_hooks"]);
  });

  it("follows Wrangler's lookup order", () => {
    const root = project({
      "wrangler.json": '{ "compatibility_flags": [] }',
      "wrangler.jsonc": '{ "compatibility_flags": ["nodejs_compat"] }',
    });

    expect(builtins(root)).toEqual([]);
  });

  it.each([
    ["no config", {}],
    ["a TOML config", { "wrangler.toml": 'compatibility_flags = ["nodejs_compat"]' }],
    ["unparseable JSON", { "wrangler.json": "{ nope" }],
  ])("provides nothing for %s", (_, files) => {
    expect(builtins(project(files))).toEqual([]);
  });
});
