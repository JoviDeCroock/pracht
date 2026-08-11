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

  it("keeps the public CLI reference in sync with every shipped command", () => {
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/index.ts"), "utf-8");
    const publicReference = readFileSync(
      resolve(repoRoot, "examples/docs/src/routes/docs/cli.md"),
      "utf-8",
    );
    const shippedCommands = Array.from(
      cliSource.matchAll(/^    ([a-z]+): \(\) => import\(/gm),
      (match) => match[1],
    ).sort();
    const documentedCommands = Array.from(
      publicReference.matchAll(/^## pracht ([a-z]+)$/gm),
      (match) => match[1],
    ).sort();

    expect(documentedCommands).toEqual(shippedCommands);
  });

  it("keeps high-risk adapter options in the public adapter guide", () => {
    const publicReference = readFileSync(
      resolve(repoRoot, "examples/docs/src/routes/docs/adapters.md"),
      "utf-8",
    );

    for (const term of [
      "canonicalOrigin",
      "trustProxy",
      "maxBodySize",
      "staleWhileRevalidate",
      "workerExportsFrom",
      "workerHandlersFrom",
      "functionName",
      "createVercelNodeListener",
      ".dev.vars",
      "@authority",
      "wrangler dev --config",
    ]) {
      expect(publicReference, `missing adapter guidance for ${term}`).toContain(term);
    }
  });

  it("keeps documented local secret files ignored", () => {
    const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf-8");

    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("!.env.example");
    expect(gitignore).toContain(".dev.vars");
  });

  it("keeps Conductor collaboration artifacts outside the formatter boundary", () => {
    const formatterConfig = JSON.parse(readFileSync(resolve(repoRoot, ".oxfmtrc.json"), "utf-8"));

    expect(formatterConfig.ignorePatterns).toContain(".context/**");
  });

  it("keeps temporary E2E project copies outside unit-test discovery", () => {
    const vitestConfig = readFileSync(resolve(repoRoot, "vitest.config.ts"), "utf-8");

    expect(vitestConfig).toContain('".tmp/**"');
  });

  it("uses the Cloudflare example's actual revalidation secret", () => {
    const readme = readFileSync(resolve(repoRoot, "examples/cloudflare/README.md"), "utf-8");
    const handler = readFileSync(
      resolve(repoRoot, "examples/cloudflare/src/api/revalidate.ts"),
      "utf-8",
    );

    expect(handler).toContain("context.env as { REVALIDATE_SECRET?: string }");
    expect(readme).toContain("REVALIDATE_SECRET=local-only-revalidation-secret");
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
