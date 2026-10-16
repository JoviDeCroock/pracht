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

function builtins(root: string, configPath?: string): string[] | true {
  const provided = cloudflareAdapter({ configPath }).edgeNodeBuiltins?.(root) ?? [];
  return provided === true ? true : [...provided];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloudflareAdapter edgeNodeBuiltins", () => {
  it("provides every builtin under Node.js compat v2", () => {
    const root = project({
      "wrangler.jsonc": `{
        "$schema": "https://example.com//schema.json", // a URL is not a comment
        "compatibility_date": "2024-09-23",
        /* block */ "compatibility_flags": ["nodejs_compat",],
      }`,
    });

    expect(builtins(root)).toBe(true);
  });

  it.each([
    ["nodejs_als", "2026-01-01", ["nodejs_als"]],
    ["nodejs_compat before 2024-09-23", "2024-09-22", ["nodejs_compat"]],
    ["no_nodejs_compat_v2", "2026-01-01", ["nodejs_compat", "no_nodejs_compat_v2"]],
  ])("provides only node:async_hooks under %s", (_, date, flags) => {
    const root = project({
      "wrangler.json": JSON.stringify({ compatibility_date: date, compatibility_flags: flags }),
    });

    expect(builtins(root)).toEqual(["node:async_hooks"]);
  });

  it("provides every builtin under nodejs_compat_v2 regardless of date", () => {
    const root = project({
      "wrangler.json": '{ "compatibility_flags": ["nodejs_compat_v2"] }',
    });

    expect(builtins(root)).toBe(true);
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
      "wrangler.jsonc": '{ "compatibility_flags": ["nodejs_als"] }',
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
