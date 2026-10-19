import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ISGSnapshot } from "@pracht/core/server";

import { readISGSnapshot, writeISGSnapshot } from "../src/node-isg.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function makeHtmlPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-isg-snapshot-"));
  tempDirs.push(dir);
  return join(dir, "index.html");
}

function snapshotOf(version: number, buildId: string | null = "build-1"): ISGSnapshot {
  return {
    html: `<main>version ${version}${"x".repeat(version * 7)}</main>`,
    headers: { "content-type": "text/html; charset=utf-8", "x-version": String(version) },
    cacheControl: null,
    buildId,
    generatedAt: 1_700_000_000_000 + version,
  };
}

describe("Node ISG snapshots", () => {
  it("publishes HTML and headers together, so no reader in another process sees a mix", async () => {
    const htmlPath = makeHtmlPath();
    writeFileSync(htmlPath, "<main>build</main>", "utf-8");
    await writeISGSnapshot(htmlPath, snapshotOf(0));

    // A second module instance has its own in-memory state, like a second
    // process sharing the static directory.
    vi.resetModules();
    const otherProcess = await import("../src/node-isg.ts");

    const writers = Array.from({ length: 40 }, (_, index) =>
      (index % 2 ? writeISGSnapshot : otherProcess.writeISGSnapshot)(
        htmlPath,
        snapshotOf(index + 1),
      ),
    );
    const reads: Array<ISGSnapshot | undefined> = [];
    let writing = true;
    const settled = Promise.all(writers).finally(() => (writing = false));
    while (writing) {
      const [mine, theirs] = await Promise.all([
        readISGSnapshot(htmlPath, "build-1"),
        otherProcess.readISGSnapshot(htmlPath, "build-1"),
      ]);
      reads.push(mine?.snapshot, theirs?.snapshot);
    }
    await settled;

    expect(reads.length).toBeGreaterThan(0);
    for (const snapshot of reads) {
      expect(snapshot).toBeDefined();
      const version = Number(snapshot!.headers["x-version"]);
      expect(snapshot).toEqual(snapshotOf(version));
    }
    // One file beside the HTML, and no leftover temporaries.
    expect(readdirSync(join(htmlPath, "..")).sort()).toEqual([
      ".index.html.pracht-isg.json",
      "index.html",
    ]);
  });

  it("ignores a snapshot another build rendered", async () => {
    const htmlPath = makeHtmlPath();
    await writeISGSnapshot(htmlPath, snapshotOf(1, "build-1"));

    await expect(readISGSnapshot(htmlPath, "build-2")).resolves.toBeNull();
    await expect(readISGSnapshot(htmlPath, "build-1")).resolves.toMatchObject({
      snapshot: snapshotOf(1, "build-1"),
    });
    // A handler that does not know its build serves whatever is there.
    await expect(readISGSnapshot(htmlPath, undefined)).resolves.toMatchObject({
      snapshot: snapshotOf(1, "build-1"),
    });
  });

  it("treats an unreadable snapshot file as no snapshot", async () => {
    const htmlPath = makeHtmlPath();
    writeFileSync(join(htmlPath, "..", ".index.html.pracht-isg.json"), "{not json", "utf-8");

    await expect(readISGSnapshot(htmlPath, undefined)).resolves.toBeNull();
  });
});
