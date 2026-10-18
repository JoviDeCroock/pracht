import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PUBLISHED, kb, syncPublishedNumbers } from "./published-numbers.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copies = [];

/** A scratch root holding only the files the publisher reads and writes. */
function copyPublishedFiles() {
  const root = mkdtempSync(join(tmpdir(), "pracht-published-numbers-"));
  copies.push(root);
  const files = new Set([
    "bench/baseline.json",
    "package.json",
    ...PUBLISHED.map((entry) => entry.file),
  ]);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(rootDir, file), join(root, file));
  }
  return root;
}

afterEach(() => {
  for (const root of copies.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("published bundle sizes", () => {
  it("match bench/baseline.json", () => {
    // Fails when the baseline moved without the pages that quote it. Fix with
    // `node bench/published-numbers.mjs --write` (or `pnpm bench:update`).
    expect(syncPublishedNumbers({ root: rootDir })).toEqual([]);
  });

  it("are rewritten from a moved baseline, and nothing else changes", () => {
    const root = copyPublishedFiles();
    const baselinePath = join(root, "bench/baseline.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const full = baseline.rungs.find((row) => row.rung === "hydration: full");
    full.coldGzipBytes += 2048;
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const stale = syncPublishedNumbers({ root });
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.join("\n")).toContain(kb(full.coldGzipBytes));

    const before = readFileSync(join(root, "README.md"), "utf8");
    expect(syncPublishedNumbers({ root, write: true })).toEqual([]);
    expect(syncPublishedNumbers({ root })).toEqual([]);

    const after = readFileSync(join(root, "README.md"), "utf8");
    expect(after).toContain(`${kb(full.coldGzipBytes)} KB fully hydrated`);
    expect(after.length).toBe(before.length);
  });

  it("are rewritten on every page that quotes a moved rung", () => {
    const root = copyPublishedFiles();
    const baselinePath = join(root, "bench/baseline.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const prefetchOff = baseline.rungs.find((row) => row.rung === "hydration: full, prefetch off");
    prefetchOff.coldGzipBytes += 2048;
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    expect(syncPublishedNumbers({ root, write: true })).toEqual([]);
    const expected = `${kb(prefetchOff.coldGzipBytes)} KB`;
    expect(readFileSync(join(root, "examples/docs/src/routes/home.tsx"), "utf8")).toContain(
      `takes full hydration to ${expected}`,
    );
    expect(
      readFileSync(join(root, "examples/docs/src/routes/docs/performance.md"), "utf8"),
    ).toContain(`prefetching off | **${expected}**`);
  });

  it("are left alone when a quote appears twice, as after a bad merge", () => {
    // Two PRs each re-recorded the baseline; the merge kept both table rows
    // and its conflict markers. Rewriting the first copy must not pass.
    const root = copyPublishedFiles();
    const page = join(root, "examples/docs/src/routes/docs/performance.md");
    const source = readFileSync(page, "utf8");
    const row = source.match(/^\| `hydration: "full"`, prefetching off \|.*$/m)[0];
    const merged = source.replace(
      row,
      `<<<<<<< HEAD\n${row}\n=======\n${row.replace(/\*\*[\d.]+ KB\*\*/, "**18.0 KB**")}\n>>>>>>> other`,
    );
    writeFileSync(page, merged);

    const problems = syncPublishedNumbers({ root, write: true });
    expect(problems).toEqual([
      expect.stringMatching(/performance\.md: has merge-conflict markers/),
      expect.stringMatching(/performance\.md: .* matches 2 times/),
    ]);
    expect(readFileSync(page, "utf8")).toBe(merged);
  });

  it("reports a quote it can no longer find", () => {
    const root = copyPublishedFiles();
    const readme = join(root, "README.md");
    writeFileSync(
      readme,
      readFileSync(readme, "utf8").replace("fully hydrated with the router", "hydrated"),
    );
    expect(syncPublishedNumbers({ root })).toEqual([
      expect.stringMatching(/^README\.md: nothing matches/),
    ]);
  });
});
