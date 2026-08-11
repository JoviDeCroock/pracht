import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveStaticFile } from "../src/node-static.ts";

const tempDirs: string[] = [];

function makeStaticDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-adapter-node-mime-"));
  tempDirs.push(root);
  const staticDir = join(root, "client");
  mkdirSync(staticDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(staticDir, name), contents, "utf-8");
  }
  return staticDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe("static content types", () => {
  it.each([
    ["skill.md", "text/markdown; charset=utf-8"],
    ["skill.markdown", "text/markdown; charset=utf-8"],
    ["llms.txt", "text/plain; charset=utf-8"],
  ])("serves %s as %s", async (file, contentType) => {
    const staticDir = makeStaticDir({ [file]: "# hello" });

    const result = await resolveStaticFile(staticDir, `/${file}`);
    expect(result?.contentType).toBe(contentType);
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const staticDir = makeStaticDir({ "archive.tar": "binary" });

    const result = await resolveStaticFile(staticDir, "/archive.tar");
    expect(result?.contentType).toBe("application/octet-stream");
  });
});
