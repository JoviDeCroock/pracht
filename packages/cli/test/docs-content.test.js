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

  // The `lead:` frontmatter is the one field with two renderers: the docs site
  // injects it into HTML, and the llms.txt generator copies it verbatim into a
  // Markdown document. Authoring it as HTML put literal `<code>` tags and
  // `&lt;Form&gt;` entities into the published agent-facing index.
  it("keeps doc lead frontmatter as Markdown, not HTML", () => {
    const offenders = [];

    for (const file of collectMarkdownAndTextFiles(["examples/docs/src/routes/docs"])) {
      const source = readFileSync(resolve(repoRoot, file), "utf-8");
      for (const line of source.split("\n")) {
        if (!line.startsWith("lead:")) continue;
        // Anything inside a code span is Markdown source, not markup — the
        // renderers escape it. Only look at what is left.
        const outsideCodeSpans = line.replaceAll(/`[^`]*`/g, "");
        if (/<[a-zA-Z/]/.test(outsideCodeSpans)) offenders.push(`${file}: HTML tag in lead`);
        if (/&[a-zA-Z]+;|&#\d+;/.test(outsideCodeSpans)) {
          offenders.push(`${file}: HTML entity in lead`);
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
    // A hyphenated subcommand (`dev-mcp`) is not a valid identifier, so its
    // registry key is quoted.
    const registered = Array.from(
      cliSource.matchAll(
        /^    "?([a-z][a-z-]*)"?: \(\) => import\("\.\/commands\/([\w-]+)\.js"\)/gm,
      ),
      (match) => ({ name: match[1], module: match[2] }),
    );

    // A deprecated alias gets no section of its own — the reference should not
    // read like the CLI has two ways to do the same thing. It still has to be
    // documented, so it is required to appear *inside* the section for the
    // command it aliases; an alias nobody can find is an alias that turns into
    // a support question.
    const aliases = [];
    const commands = [];
    for (const entry of registered) {
      const source = readFileSync(
        resolve(repoRoot, `packages/cli/src/commands/${entry.module}.ts`),
        "utf-8",
      );
      const alias = /description:\s*"Deprecated alias for `pracht ([a-z][a-z-]*)`"/.exec(source);
      if (alias) aliases.push({ name: entry.name, aliasOf: alias[1] });
      else commands.push(entry.name);
    }

    const sections = new Map();
    const headings = [...publicReference.matchAll(/^## pracht ([a-z][a-z-]*)$/gm)];
    for (const [i, heading] of headings.entries()) {
      const start = heading.index + heading[0].length;
      const end = headings[i + 1]?.index ?? publicReference.length;
      sections.set(heading[1], publicReference.slice(start, end));
    }

    expect([...sections.keys()].sort()).toEqual(commands.sort());

    // Guard the guard: if the alias regex ever stops matching, the check above
    // silently starts demanding a section for the alias instead of skipping it,
    // so assert the alias set is the one we know ships.
    expect(aliases).toEqual([{ name: "mcp", aliasOf: "dev-mcp" }]);
    for (const alias of aliases) {
      const section = sections.get(alias.aliasOf);
      expect(section, `cli.md has no "## pracht ${alias.aliasOf}" section`).toBeDefined();
      expect(
        section,
        `"pracht ${alias.name}" is a shipped alias but is not mentioned under "## pracht ${alias.aliasOf}"`,
      ).toContain(`pracht ${alias.name}`);
    }
  });

  // The manifest-only limitation was documented in docs/ROUTING.md but never on
  // the public site, so a reader choosing the pages router could not learn that
  // it has no capability, MCP, or agent-trust surface until much later.
  it("publishes the pages-router limitations on the public site", () => {
    const routing = readFileSync(
      resolve(repoRoot, "examples/docs/src/routes/docs/routing.md"),
      "utf-8",
    );
    expect(routing).toContain("What the pages router does not have");
    for (const feature of ["Capabilities", "Middleware", "WebMCP", "pracht eval", "constraints"]) {
      expect(routing).toContain(feature);
    }

    // The two pages a reader lands on when they want the agent surface must
    // point back at that table rather than silently assuming a manifest.
    for (const file of [
      "examples/docs/src/routes/docs/capabilities.md",
      "examples/docs/src/routes/docs/agent-trust.md",
    ]) {
      const source = readFileSync(resolve(repoRoot, file), "utf-8");
      expect(source).toContain("Manifest router only");
      expect(source).toContain("/docs/routing#what-the-pages-router-does-not-have");
    }
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
