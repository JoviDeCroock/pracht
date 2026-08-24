import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findWranglerConfig,
  readWranglerAssetsHtmlHandling,
  readWranglerMainEntries,
  readWranglerBundleSettings,
  WRANGLER_CONFIG_FILES,
} from "../src/wrangler-config.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { force: true, recursive: true });
});

function writeConfig(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-wrangler-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, contents, "utf-8");
  return file;
}

describe("findWranglerConfig", () => {
  it("uses wrangler's own precedence: .json, then .jsonc, then .toml", () => {
    expect(WRANGLER_CONFIG_FILES).toEqual(["wrangler.json", "wrangler.jsonc", "wrangler.toml"]);

    const dir = mkdtempSync(join(tmpdir(), "pracht-wrangler-order-"));
    dirs.push(dir);
    writeFileSync(join(dir, "wrangler.toml"), 'main = "a.js"\n', "utf-8");
    writeFileSync(join(dir, "wrangler.jsonc"), '{ "main": "b.js" }', "utf-8");
    expect(findWranglerConfig(dir)).toBe(join(dir, "wrangler.jsonc"));

    writeFileSync(join(dir, "wrangler.json"), '{ "main": "c.js" }', "utf-8");
    expect(findWranglerConfig(dir)).toBe(join(dir, "wrangler.json"));
  });

  it("returns null when no config exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pracht-wrangler-none-"));
    dirs.push(dir);
    expect(findWranglerConfig(dir)).toBeNull();
  });
});

describe("readWranglerMainEntries", () => {
  it("ignores commented-out jsonc keys", () => {
    const file = writeConfig(
      "wrangler.jsonc",
      `{
  "name": "app",
  // "main": "dist/server/server.js",
  /* "main": "dist/server/legacy.js", */
  "main": "dist/server/worker.js"
}
`,
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
    ]);
  });

  it("does not treat comment-like text inside a string as a comment", () => {
    const file = writeConfig(
      "wrangler.json",
      '{ "name": "a//b", "main": "dist/server/worker.js" }',
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
    ]);
  });

  it("tolerates trailing commas", () => {
    const file = writeConfig(
      "wrangler.jsonc",
      '{\n  "main": "dist/server/worker.js",\n  "assets": { "binding": "ASSETS", },\n}\n',
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
    ]);
  });

  it("reports the top-level main and every env override", () => {
    const file = writeConfig(
      "wrangler.json",
      JSON.stringify({
        main: "dist/server/worker.js",
        env: {
          production: { main: "dist/server/server.js" },
          staging: { vars: { A: "1" } },
        },
      }),
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
      { environment: "production", main: "dist/server/server.js" },
    ]);
  });

  it("does not mistake a nested main for the top-level one", () => {
    const file = writeConfig(
      "wrangler.json",
      JSON.stringify({
        env: { staging: { main: "dist/server/server.js" } },
        main: "dist/server/worker.js",
      }),
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
      { environment: "staging", main: "dist/server/server.js" },
    ]);
  });

  it("reads toml with either quote style, ignoring non-env tables", () => {
    const file = writeConfig(
      "wrangler.toml",
      [
        "name = 'app'",
        "main = 'dist/server/worker.js'  # the deploy entry",
        "",
        "[build]",
        'main = "dist/server/ignored.js"',
        "",
        "[env.production]",
        'main = "dist/server/server.js"',
      ].join("\r\n"),
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
      { environment: "production", main: "dist/server/server.js" },
    ]);
  });

  it("returns nothing for unparseable or main-less configs", () => {
    expect(readWranglerMainEntries(writeConfig("wrangler.json", "{ not json"))).toEqual([]);
    expect(readWranglerMainEntries(writeConfig("wrangler.json", '{ "name": "app" }'))).toEqual([]);
    expect(readWranglerMainEntries(join(tmpdir(), "pracht-missing-wrangler.json"))).toEqual([]);
  });
  it("attributes main correctly across headers carrying trailing comments", () => {
    const file = writeConfig(
      "wrangler.toml",
      [
        'main = "dist/server/worker.js"',
        "",
        "[[kv_namespaces]]",
        'binding = "KV"',
        "",
        "[env.staging]  # wrangler deploy --env staging",
        'main = "dist/server/server.js"',
      ].join("\n"),
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
      { environment: "staging", main: "dist/server/server.js" },
    ]);
  });

  it("reads dotted toml env keys", () => {
    const file = writeConfig(
      "wrangler.toml",
      ['main = "dist/server/worker.js"', 'env.production.main = "dist/server/server.js"'].join(
        "\n",
      ),
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
      { environment: "production", main: "dist/server/server.js" },
    ]);
  });

  it("skips toml shapes it cannot read rather than guessing", () => {
    // An inline `env` table is valid TOML this reader does not parse. Reporting
    // nothing is correct; callers must not read that as "config is fine".
    const file = writeConfig(
      "wrangler.toml",
      [
        'main = "dist/server/worker.js"',
        'env = { production = { main = "dist/server/server.js" } }',
      ].join("\n"),
    );

    expect(readWranglerMainEntries(file)).toEqual([
      { environment: null, main: "dist/server/worker.js" },
    ]);
  });
});

describe("readWranglerAssetsHtmlHandling", () => {
  it("reports an explicit html_handling value", () => {
    const file = writeConfig(
      "wrangler.jsonc",
      `{
        // Comment tolerated.
        "assets": { "binding": "ASSETS", "html_handling": "drop-trailing-slash" },
      }`,
    );
    expect(readWranglerAssetsHtmlHandling(file)).toEqual({
      htmlHandling: "drop-trailing-slash",
    });
  });

  it("reports an assets block that leaves html_handling at wrangler's default", () => {
    const file = writeConfig(
      "wrangler.jsonc",
      `{ "assets": { "binding": "ASSETS", "directory": "dist/client" } }`,
    );
    expect(readWranglerAssetsHtmlHandling(file)).toEqual({ htmlHandling: undefined });
  });

  it("returns null — unknown, not fine — for shapes it cannot prove", () => {
    // No assets block at all.
    expect(
      readWranglerAssetsHtmlHandling(writeConfig("wrangler.jsonc", `{ "main": "worker.js" }`)),
    ).toBeNull();
    // Unparsable.
    expect(readWranglerAssetsHtmlHandling(writeConfig("wrangler.jsonc", "{ nope"))).toBeNull();
    // TOML is not parsed here.
    expect(readWranglerAssetsHtmlHandling(writeConfig("wrangler.toml", 'name = "app"'))).toBeNull();
    // Missing file.
    expect(readWranglerAssetsHtmlHandling(join(tmpdir(), "definitely-absent.jsonc"))).toBeNull();
    // A non-string value is not an explicit setting.
    expect(
      readWranglerAssetsHtmlHandling(
        writeConfig("wrangler.jsonc", `{ "assets": { "html_handling": 3 } }`),
      ),
    ).toEqual({ htmlHandling: undefined });
  });
});

describe("readWranglerBundleSettings", () => {
  it("reads JSONC and TOML settings", () => {
    expect(
      readWranglerBundleSettings(
        writeConfig(
          "wrangler.jsonc",
          `{ "no_bundle": true, "rules": [{ "type": "ESModule", "globs": ["**/*.js"] }] }`,
        ),
      ),
    ).toEqual({ noBundle: true, hasJavaScriptModuleRule: true });
    expect(
      readWranglerBundleSettings(
        writeConfig(
          "wrangler.toml",
          `no_bundle = false # let wrangler bundle\n[[rules]]\ntype = "ESModule"\nglobs = ["**/*.js", "**/*.mjs"]\n`,
        ),
      ),
    ).toEqual({ noBundle: false, hasJavaScriptModuleRule: true });
  });

  it("distinguishes an omitted setting from an unreadable config", () => {
    expect(
      readWranglerBundleSettings(writeConfig("wrangler.jsonc", `{ "main": "worker.js" }`)),
    ).toEqual({ noBundle: undefined, hasJavaScriptModuleRule: false });
    expect(readWranglerBundleSettings(writeConfig("wrangler.jsonc", `{ nope`))).toBeNull();
  });
});
