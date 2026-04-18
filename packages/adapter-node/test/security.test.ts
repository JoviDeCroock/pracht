import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveStaticFile } from "../src/node-static.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-adapter-node-sec-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe("resolveStaticFile symlink protection", () => {
  it("refuses to serve a symlink pointing outside the static root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const staticDir = join(root, "client");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET", "utf-8");

    // Attacker controls the build artifact: places a symlink inside
    // the static root that points at a sensitive file outside it.
    symlinkSync(join(outside, "secret.txt"), join(staticDir, "leak.txt"));

    const result = await resolveStaticFile(staticDir, "/leak.txt");
    expect(result).toBeNull();
  });

  it("still serves regular files inside the static root", async () => {
    const root = makeTempDir();
    const staticDir = join(root, "client");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "app.js"), "console.log(1)", "utf-8");

    const result = await resolveStaticFile(staticDir, "/app.js");
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe(join(staticDir, "app.js"));
  });
});
