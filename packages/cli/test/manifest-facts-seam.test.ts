import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Seam guard: the CLI learns what the manifest says from the resolved app
// graph or the pracht plugin's manifest facts, not from its own text scan of
// routes or route exports, so a new copy of such a reader fails here.
const srcDir = join(import.meta.dirname, "../src");

function sources(dir: string): { name: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [{ name: path, text: readFileSync(path, "utf-8") }] : [];
  });
}

describe("manifest facts in the CLI", () => {
  it("has no text reader for routes or head exports", () => {
    const readers = [
      // A `route(` counter over the manifest's source.
      /\\broute\\s\*\\\(/,
      // A `head` export detector over a route module's source.
      /\\s\+head\\b/,
    ];
    for (const { name, text } of sources(srcDir)) {
      for (const reader of readers) expect(reader.test(text), `${name} ${reader}`).toBe(false);
    }
  });
});
