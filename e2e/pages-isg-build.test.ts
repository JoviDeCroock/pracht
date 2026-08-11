import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/pages-router");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pages-router ISG emits adapter-native time revalidation across adapters", () => {
  test.setTimeout(180_000);
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-pages-isg-"));

  try {
    for (const adapter of ["node", "cloudflare", "vercel"] as const) {
      const projectDir = resolve(tempDir, adapter);
      cpSync(fixtureDir, projectDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
      execFileSync(process.execPath, [cliEntry, "build"], {
        cwd: projectDir,
        env: {
          ...process.env,
          NODE_OPTIONS: "--experimental-strip-types",
          PRACHT_ADAPTER: adapter,
        },
        stdio: "pipe",
      });

      if (adapter === "node") {
        const manifest = JSON.parse(
          readFileSync(resolve(projectDir, "dist/server/isg-manifest.json"), "utf-8"),
        );
        expect(manifest["/pricing"].revalidate).toEqual({ kind: "time", seconds: 60 });
      } else if (adapter === "cloudflare") {
        const manifest = JSON.parse(
          readFileSync(resolve(projectDir, "dist/client/_pracht/isg.json"), "utf-8"),
        );
        expect(manifest["/pricing"].revalidate).toEqual({ kind: "time", seconds: 60 });
      } else {
        const config = JSON.parse(
          readFileSync(
            resolve(projectDir, ".vercel/output/functions/pricing.prerender-config.json"),
            "utf-8",
          ),
        );
        expect(config.expiration).toBe(60);
        expect(config).toHaveProperty("fallback");
        expect(existsSync(resolve(projectDir, ".vercel/output/functions/pricing.func"))).toBe(true);
        expect(
          existsSync(
            resolve(projectDir, ".vercel/output/functions/pricing.prerender-fallback.html"),
          ),
        ).toBe(true);
        expect(existsSync(resolve(projectDir, ".vercel/output/static/pricing/index.html"))).toBe(
          false,
        );
      }
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
