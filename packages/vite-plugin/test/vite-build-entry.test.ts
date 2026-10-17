import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createApp(): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-vite-build-entry-"));
  roots.push(root);
  mkdirSync(join(root, "src/pages"), { recursive: true });
  writeFileSync(
    join(root, "src/pages/index.tsx"),
    "export function Component() { return <h1>home</h1>; }\n",
  );
  return root;
}

describe("plain vite build", () => {
  it("fails with a pointer to pracht build instead of an unresolved index.html", async () => {
    const root = createApp();

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: pracht({ pagesDir: "/src/pages" }),
        build: { write: false },
      }),
    ).rejects.toThrow(
      "[pracht] `vite build` has no entry to build: a pracht app has no index.html. Run " +
        "`pracht build` instead",
    );
  });
});
