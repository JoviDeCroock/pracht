import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Vite does not minify an app's server build, so a doc comment in a package's
// published ESM ships in every server bundle that imports it. Packages whose
// code lands in an app bundle strip them (the `.d.mts` keep them); build-time
// tools keep theirs. A new package must be sorted into one of the two lists.
const RUNTIME_PACKAGES = [
  "adapter-cloudflare",
  "adapter-netlify",
  "adapter-node",
  "adapter-static",
  "adapter-vercel",
  "capabilities",
  "content",
  "framework",
  "i18n",
  "image",
  "markdown",
  "openapi",
  "query",
  "session",
];
const TOOL_PACKAGES = ["cli", "preact-ssr-precompile", "test", "vite-plugin"];

/** A doc comment opening a line; glob strings such as `${dir}/**` do not count. */
const DOC_COMMENT = /^\s*\/\*\*/m;

const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));

function distFiles(pkg: string, extension: string): string[] {
  const dist = join(packagesRoot, pkg, "dist");
  if (!existsSync(dist)) throw new Error(`packages/${pkg}/dist is missing; run pnpm build first.`);
  return readdirSync(dist, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(extension))
    .map((file) => join(dist, file));
}

describe("published package comments", () => {
  it("sorts every compiled package into runtime or tool", () => {
    const compiled = readdirSync(packagesRoot).filter((pkg) =>
      existsSync(join(packagesRoot, pkg, "tsdown.config.ts")),
    );
    expect(compiled.sort()).toEqual([...RUNTIME_PACKAGES, ...TOOL_PACKAGES].sort());
  });

  it.each(RUNTIME_PACKAGES)("ships %s without doc comments in its JavaScript", (pkg) => {
    const withDocComments = distFiles(pkg, ".mjs").filter((file) =>
      DOC_COMMENT.test(readFileSync(file, "utf-8")),
    );
    expect(withDocComments).toEqual([]);
  });

  it("keeps doc comments in the declarations and annotations in the JavaScript", () => {
    const declarations = distFiles("framework", ".d.mts").map((file) =>
      readFileSync(file, "utf-8"),
    );
    expect(declarations.some((source) => DOC_COMMENT.test(source))).toBe(true);
    const javascript = distFiles("framework", ".mjs").map((file) => readFileSync(file, "utf-8"));
    expect(javascript.some((source) => source.includes("@__PURE__"))).toBe(true);
  });
});
