import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Seam guard: build-time facts about source files have one reader
// (`analysis.ts` over `readModuleFacts()`), so the next copy of a reader fails
// here instead of drifting from the first.
const srcDir = join(import.meta.dirname, "../src");
const sources = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(join(srcDir, name), "utf-8") }));

function filesMatching(pattern: RegExp): string[] {
  return sources.filter(({ text }) => pattern.test(text)).map(({ name }) => name);
}

describe("one source-analysis reader", () => {
  it("parses route modules for their exports in one place", () => {
    expect(filesMatching(/from "@babel\/parser"/)).toEqual(["route-loader-hints.ts"]);
    // Route exports are answered for all hint tables at once, never per export.
    expect(filesMatching(/\bdetect(?:Loader|Head|Headers|StaticPaths)Export\(/)).toEqual([]);
    expect(filesMatching(/\binspectParsedModuleExports\(/)).toEqual(["route-loader-hints.ts"]);
  });

  it("spells module identity in one place", () => {
    expect(
      filesMatching(/\bfunction (?:canonicalModuleId|fileModuleId|toPosixPath|scanFiles)\b/),
    ).toEqual(["module-id.ts"]);
  });

  it("reads the app manifest in one place", () => {
    // Codegen, the app root and every other consumer take `manifest()` facts.
    // Besides it, only the pages scanner (page value exports) and the client
    // transform (which rewrites the code it parses) parse source.
    expect(filesMatching(/\bparseAst\(/).sort()).toEqual([
      "analysis.ts",
      "client-module-transform.ts",
      "pages-router.ts",
    ]);
    expect(filesMatching(/\bfunction (?:collectPositionalRefs|collectManifestStrings)\b/)).toEqual([
      "analysis.ts",
    ]);
    expect(filesMatching(/\bsameFileStamp\(/).sort()).toEqual([
      "analysis.ts",
      "pages-router.ts",
      "route-loader-hints.ts",
    ]);
  });
});
