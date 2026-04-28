import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC_ROOTS = ["README.md", "docs", "examples/docs/src/routes/docs"];
const STALE_PATTERNS = [
  /from ["']pracht["']/,
  /declare module ["']pracht["']/,
  /github\.com\/JoviDeCroock\/viact/,
  /import \{ node \} from ["']@pracht\/adapter-node["']/,
  /adapter: node\(\)/,
];

describe("documentation content", () => {
  it("does not contain stale package names or old adapter APIs", () => {
    const offenders = [];

    for (const file of collectMarkdownAndTextFiles(DOC_ROOTS)) {
      const source = readFileSync(resolve(repoRoot, file), "utf-8");
      for (const pattern of STALE_PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${file} matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function collectMarkdownAndTextFiles(paths) {
  const files = [];
  for (const path of paths) {
    const absolute = resolve(repoRoot, path);
    if (path.endsWith(".md")) {
      files.push(path);
      continue;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...collectMarkdownAndTextFiles([child]));
      } else if (/\.(md|mdx|tsx?)$/.test(entry.name)) {
        files.push(child);
      }
    }
  }
  return files;
}
