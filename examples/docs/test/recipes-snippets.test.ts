// Typechecks the code fences on every `recipes-*.md` page against the real
// `@pracht/*` sources.
//
// The recipes are the pages a reader copies verbatim, and nothing tied them to
// the framework they document: `recipes-forms.md` shipped an `onResponse`
// handler bound straight to a `useState` setter for long enough that the
// flagship form example silently rendered nothing.
//
// A doc snippet is not an application, so a plain `tsc` run over one reports
// mostly noise. Three things keep the signal:
//
//   - **One program per page.** Pages augment `Register` from a `src/env.d.ts`
//     fence to type `context.env` / `context.locale` / `context.logger`. Those
//     augmentations have to reach the page's other fences and nowhere else —
//     merged into one program they contradict each other, and split per fence
//     they do not apply at all.
//   - **Unresolved names are only an error when a pracht package exports
//     them.** Recipes deliberately elide the app's own helpers (`db`,
//     `sendEmail`, `sessionFromRequest`), and naming them is the point. An
//     unresolved `ApiRouteArgs` is the opposite: a missing import, which is
//     exactly the "copy this and it does not compile" failure worth catching.
//     Same rule one level up for modules: `./db` is elided, `@pracht/core` is
//     not.
//   - **`noImplicitAny` off.** A recipe that writes `function Component({ data
//     })` has elided the annotation on purpose. Every other `strict` check
//     stays on.
//
// A fence that is not a module at all — a bare JSX element, an object-literal
// fragment, a class body — opts out with `<!-- snippet: partial -->` on the
// line above it. See docs/WORKSPACE.md.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const docsDir = resolve(repoRoot, "examples/docs/src/routes/docs");
// Outside every `include` glob in the root tsconfig and inside `.gitignore`, so
// the generated files are neither committed nor typechecked a second time.
const workDir = resolve(repoRoot, ".tmp/docs-snippets");

const PARTIAL_MARKER = "<!-- snippet: partial -->";

// Owned by another workstream, so its fences are extracted and checked but its
// failures are not yet a gate. A pending page that becomes clean fails the
// suite below, so this list cannot outlive the problem it names.
const PENDING_PAGES = new Set(["recipes-auth.md"]);

interface Snippet {
  page: string;
  /** 1-based line of the opening fence, for a jump-to-source failure message. */
  line: number;
  /** The `[src/api/contact.ts]` label after the language, when present. */
  label: string;
  file: string;
}

function extractSnippets(page: string): { checked: Snippet[]; partial: number } {
  const lines = readFileSync(join(docsDir, page), "utf-8").split("\n");
  const checked: Snippet[] = [];
  let partial = 0;
  let index = 0;

  for (let i = 0; i < lines.length; i++) {
    const open = /^```tsx?(?:\s+\[([^\]]*)\])?\s*$/.exec(lines[i]);
    if (!open) continue;

    let end = i + 1;
    while (end < lines.length && lines[end].trimEnd() !== "```") end++;
    const code = lines.slice(i + 1, end).join("\n");
    const fenceLine = i;
    i = end;

    // The marker sits directly above the fence; blank lines between them are a
    // Markdown formatting choice, not a different intent.
    let above = fenceLine - 1;
    while (above >= 0 && lines[above].trim() === "") above--;
    if (above >= 0 && lines[above].trim() === PARTIAL_MARKER) {
      partial++;
      continue;
    }

    // Every fence compiles as `.tsx`, whatever its language tag says: pages
    // label component code `ts` about as often as `tsx`, and parsing JSX as
    // `.ts` reads `<div>` as a comparison and buries every real error under a
    // hundred "unterminated regular expression literal"s. The cost is that an
    // angle-bracket type assertion would not parse; no recipe uses one, and
    // `as` is the house style.
    const slug = page.replace(/\.md$/, "");
    const file = join(workDir, `${slug}__${index++}.tsx`);
    // A fence with no import or export is a script, and scripts on one page
    // share a global scope — two `const response = …` snippets would collide
    // with each other rather than say anything about the framework. Top-level
    // `await` needs the same thing.
    const body = /^\s*(?:import|export)\b/m.test(code) ? code : `${code}\nexport {};`;
    writeFileSync(file, `${body}\n`, "utf-8");
    checked.push({ page, line: fenceLine + 1, label: open[1] ?? "", file });
  }

  return { checked, partial };
}

/** The root tsconfig owns the `@pracht/*` -> source `paths` the snippets need. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = resolve(repoRoot, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, repoRoot, undefined, configPath);
  return {
    ...parsed.options,
    // A recipe is written for an app that has not opted into this repo's
    // module-syntax policy, so `import { ApiRouteArgs }` without `type` is
    // idiomatic there and must not read as an error here.
    verbatimModuleSyntax: false,
    isolatedModules: false,
    noImplicitAny: false,
    noEmit: true,
    types: ["node", "vite/client"],
  };
}

const pages = readdirSync(docsDir)
  .filter((name) => name.startsWith("recipes-") && name.endsWith(".md"))
  .sort();

rmSync(workDir, { force: true, recursive: true });
mkdirSync(workDir, { recursive: true });

const options = compilerOptions();
const entryPoints = Object.keys(options.paths ?? {});
const probeFile = join(workDir, "__exports.tsx");
writeFileSync(
  probeFile,
  `${entryPoints
    .map((entry, i) => `import * as m${i} from ${JSON.stringify(entry)};`)
    .join("\n")}\nexport {};\n`,
  "utf-8",
);

const extracted = new Map(pages.map((page) => [page, extractSnippets(page)]));

// One host across every program: parsing lib.d.ts and the whole `@pracht/core`
// source graph once instead of eleven times is the difference between a second
// and a minute.
const baseHost = ts.createCompilerHost(options, true);
const sourceFileCache = new Map<string, ts.SourceFile | undefined>();
const host: ts.CompilerHost = {
  ...baseHost,
  getSourceFile(fileName, languageVersion, onError, shouldCreate) {
    // Snippet files are per-page and rewritten between runs; nothing else is.
    if (fileName.startsWith(workDir)) {
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    }
    if (!sourceFileCache.has(fileName)) {
      sourceFileCache.set(
        fileName,
        baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreate),
      );
    }
    return sourceFileCache.get(fileName);
  },
};

/** Named exports of every `@pracht/*` entry point the root tsconfig maps. */
function prachtExportNames(): Set<string> {
  const program = ts.createProgram({ rootNames: [probeFile], options, host });
  const checker = program.getTypeChecker();
  const probe = program.getSourceFile(probeFile);
  const names = new Set<string>();
  if (!probe) return names;

  for (const statement of probe.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const binding = statement.importClause?.namedBindings;
    if (!binding || !ts.isNamespaceImport(binding)) continue;
    const symbol = checker.getSymbolAtLocation(binding.name);
    if (!symbol) continue;
    for (const exported of checker.getExportsOfModule(checker.getAliasedSymbol(symbol))) {
      names.add(exported.name);
    }
  }
  return names;
}

const exportNames = prachtExportNames();
const PRACHT_MODULE = /^(@pracht\/|preact($|\/))/;

/** Codes for "cannot find name X": plain, with a spelling suggestion, and the
 * "install @types for a test runner" variant. */
const UNRESOLVED_NAME = new Set([2304, 2552, 2593]);

function isElision(diagnostic: ts.Diagnostic): boolean {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (UNRESOLVED_NAME.has(diagnostic.code)) {
    const name = /Cannot find name '([^']+)'/.exec(text)?.[1];
    return name !== undefined && !exportNames.has(name);
  }
  if (diagnostic.code === 2307) {
    const specifier = /Cannot find module '([^']+)'/.exec(text)?.[1];
    return specifier !== undefined && !PRACHT_MODULE.test(specifier);
  }
  return false;
}

function checkPage(page: string): string[] {
  const { checked } = extracted.get(page)!;
  if (checked.length === 0) return [];

  const files = new Map(checked.map((snippet) => [snippet.file, snippet]));
  const program = ts.createProgram({ rootNames: [...files.keys()], options, host });
  const messages: string[] = [];

  for (const diagnostic of [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]) {
    if (!diagnostic.file) continue;
    const snippet = files.get(resolve(diagnostic.file.fileName));
    if (!snippet || isElision(diagnostic)) continue;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    messages.push(
      `  ${snippet.page}:${snippet.line}${snippet.label ? ` [${snippet.label}]` : ""} ` +
        `(fence line ${line + 1}): TS${diagnostic.code} ` +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    );
  }
  return messages;
}

const results = new Map(pages.map((page) => [page, checkPage(page)]));

describe("recipes-*.md code fences", () => {
  it("resolves every @pracht/* entry point named by the root tsconfig", () => {
    expect(entryPoints.length).toBeGreaterThan(10);
    // Without these the missing-import rule silently degrades to "allow
    // everything", and the whole suite passes while checking nothing.
    expect(exportNames.has("Form")).toBe(true);
    expect(exportNames.has("ApiRouteArgs")).toBe(true);
    expect(exportNames.has("defineApp")).toBe(true);
  });

  it("finds fences to check", () => {
    const total = pages.reduce((sum, page) => sum + extracted.get(page)!.checked.length, 0);
    expect(total).toBeGreaterThan(60);
  });

  for (const page of pages.filter((page) => !PENDING_PAGES.has(page))) {
    const { checked, partial } = extracted.get(page)!;
    it(`typechecks ${page} (${checked.length} fences, ${partial} partial)`, () => {
      const messages = results.get(page)!;
      expect(messages.join("\n")).toBe("");
    });
  }

  for (const page of PENDING_PAGES) {
    it(`${page} is still pending`, () => {
      expect(pages).toContain(page);
      expect(
        results.get(page)!.length,
        `${page} now typechecks — remove it from PENDING_PAGES.`,
      ).toBeGreaterThan(0);
    });
  }
});
