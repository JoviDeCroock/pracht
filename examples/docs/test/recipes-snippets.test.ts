// Typechecks the code fences on every `recipes-*.md` page against the real
// `@pracht/*` sources.
//
// The recipes are the pages a reader copies verbatim, and nothing tied them to
// the framework they document: `recipes-forms.md` shipped an `onResponse`
// handler bound straight to a `useState` setter for long enough that the
// flagship form example silently rendered nothing.
//
// A doc snippet is not an application, so a plain `tsc` run over one reports
// mostly noise. Four things keep the signal:
//
//   - **One program per page, laid out at the paths the fences declare.** A
//     fence labelled `[src/i18n/index.ts]` is written to `src/i18n/index.ts`,
//     so `import { dictionaries } from "../i18n/index.ts"` in the page's
//     `src/routes/home.tsx` fence resolves to the page's own dictionary rather
//     than collapsing to `any`. That is what makes `tPlural(msgs,
//     "cart.items", n)` a real check of the keys the page declares. It is also
//     what makes the `src/env.d.ts` `Register` augmentations reach the page's
//     other fences — and only those.
//   - **Unresolved names are an error when they name, or nearly name, a pracht
//     export.** Recipes deliberately elide the app's own helpers (`db`,
//     `sendEmail`), and naming them is the point. An unresolved `ApiRouteArgs`
//     is the opposite: a missing import. So is a typo'd one — suppressing
//     every unknown identifier would wave `useRevalidat()` straight through,
//     which is the exact "copy this and it does not compile" failure this
//     exists to catch.
//   - **`noImplicitAny` off.** A recipe that writes `function Component({ data
//     })` has elided the annotation on purpose. Every other `strict` check
//     stays on.
//   - **A narrow Cloudflare ambient shim.** This repo has no
//     `@cloudflare/workers-types`, and without one `context.env.DB` is `any`
//     and the Cloudflare recipes are checked in name only.
//
// A fence that is not a module at all — a bare JSX element, an object-literal
// fragment, a loop body — opts out with `<!-- snippet: partial -->` on the line
// above it. It is the last resort, not the first: a missing import is the
// failure this test exists to find, and adding the import is the fix.
// See docs/WORKSPACE.md.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const docsDir = resolve(repoRoot, "examples/docs/src/routes/docs");
// Outside every `include` glob in the root tsconfig and inside `.gitignore`, so
// the generated files are neither committed nor typechecked a second time.
const workDir = resolve(repoRoot, ".tmp/docs-snippets");

/** TypeScript reports paths with forward slashes whatever the platform does. */
const posix = (path: string) => path.replace(/\\/g, "/");

const PARTIAL_MARKER = "<!-- snippet: partial -->";

/** Any fence, so an unrecognised TypeScript info string can be counted. */
const ANY_FENCE = /^```(\S+)(.*)$/;
/** The one form this harness understands: ```` ```ts ```` or ```` ```tsx [path] ````. */
const TS_FENCE = /^```(tsx?)(?:\s+\[([^\]]+)\])?\s*$/;

// A pending page is still extracted, but its diagnostics do not gate the
// suite. Keep this empty unless a parallel workstream temporarily owns a page.
const PENDING_PAGES = new Set<string>();

/**
 * A stand-in for `@cloudflare/workers-types`, which this repo does not depend
 * on. Deliberately only as wide as the Cloudflare recipes use: the point is
 * that `context.env.DB` is *something* rather than `any`, so a fence that
 * misuses it fails. Widen it when a recipe needs more; never speculatively.
 */
// A script, not a module: `declare module "cloudflare:workers"` is only an
// *ambient* declaration in a file with no top-level import or export. In a
// module it would be read as an augmentation of a module that does not exist,
// which fails on a file nothing reports diagnostics for — so `DurableObject`
// would quietly stay unresolved.
const CLOUDFLARE_AMBIENT = `
interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { last_row_id: number; changes: number; duration: number };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string, type: "text"): Promise<string | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
interface DurableObjectId {
  toString(): string;
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
interface ResponseInit {
  webSocket?: WebSocket | null;
}

declare module "cloudflare:workers" {
  export class DurableObject<TEnv = unknown> {
    protected ctx: {
      acceptWebSocket(socket: WebSocket): void;
      getWebSockets(): WebSocket[];
    };
    protected env: TEnv;
    fetch(request: Request): Response | Promise<Response>;
    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
  }
}
`;

interface Snippet {
  page: string;
  /** 1-based line of the opening fence, for a jump-to-source failure message. */
  line: number;
  /** The `[src/api/contact.ts]` label after the language, when present. */
  label: string;
  file: string;
}

/**
 * One compilable tree for a page.
 *
 * A page that shows the same path twice is showing the app at two points in
 * its life — `recipes-i18n.md` has a `src/i18n/index.ts` built on
 * `@pracht/i18n` and, in its appendix, a hand-rolled replacement for the same
 * file. Each redefinition opens a new layer that carries everything defined
 * before it, so a fence resolves `../i18n` to the version it was written
 * beside. Only the fences a layer introduces are reported from it; the rest
 * are there to be imported.
 */
interface Layer {
  roots: string[];
  reported: Map<string, Snippet>;
}

interface PageFences {
  layers: Layer[];
  checked: Snippet[];
  partial: number;
  /** Info strings this harness could not parse — a silent skip is a hole. */
  unrecognized: string[];
  /**
   * A `.ts` fence that had to be compiled as `.tsx` (it contains JSX) but is
   * imported somewhere by its literal `.ts` path. No page does this today; the
   * check exists so that if one starts, it fails loudly instead of silently
   * eliding the import.
   */
  unresolvablePromotions: string[];
}

interface RawFence {
  line: number;
  label: string;
  lang: string;
  code: string;
}

/**
 * `.ts` cannot parse JSX, and the pages label component code `ts` about as
 * often as `tsx`. Rather than guess with a regex, parse it both ways and take
 * the one the compiler is happier with; ties keep the declared extension.
 */
function preferTsx(code: string, declared: string): boolean {
  const errors = (kind: ts.ScriptKind) =>
    (
      ts.createSourceFile("probe", code, ts.ScriptTarget.ESNext, false, kind) as unknown as {
        parseDiagnostics?: unknown[];
      }
    ).parseDiagnostics?.length ?? 0;
  if (declared === ".tsx") return true;
  return errors(ts.ScriptKind.TSX) < errors(ts.ScriptKind.TS);
}

function parseFences(page: string): { raw: RawFence[]; unrecognized: string[] } {
  const lines = readFileSync(join(docsDir, page), "utf-8").split("\n");
  const raw: RawFence[] = [];
  const unrecognized: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const any = ANY_FENCE.exec(lines[i]);
    if (!any) continue;

    let end = i + 1;
    while (end < lines.length && lines[end].trimEnd() !== "```") end++;
    const code = lines.slice(i + 1, end).join("\n");
    const fenceLine = i;
    i = end;

    if (!/^tsx?$/.test(any[1])) continue; // bash, json, md — not ours.
    const match = TS_FENCE.exec(lines[fenceLine]);
    if (!match) {
      // Silently skipping a fence this harness cannot parse is how a page
      // quietly leaves the gate. Fail instead and widen `TS_FENCE`.
      unrecognized.push(`${page}:${fenceLine + 1}: ${lines[fenceLine]}`);
      continue;
    }

    // The marker sits directly above the fence; blank lines between them are a
    // Markdown formatting choice, not a different intent.
    let above = fenceLine - 1;
    while (above >= 0 && lines[above].trim() === "") above--;
    const isPartial = above >= 0 && lines[above].trim() === PARTIAL_MARKER;

    raw.push({
      line: fenceLine + 1,
      label: isPartial ? "\0partial" : (match[2] ?? ""),
      lang: match[1],
      code,
    });
  }

  return { raw, unrecognized };
}

/**
 * A fence with no import or export is a script, and scripts in one program
 * share a global scope — two `const response = …` snippets would collide with
 * each other rather than say anything about the framework. Top-level `await`
 * needs the same thing.
 */
function asModule(code: string): string {
  return /^\s*(?:import|export|declare)\b/m.test(code) ? code : `${code}\nexport {};`;
}

function extractSnippets(page: string): PageFences {
  const { raw, unrecognized } = parseFences(page);
  const slug = page.replace(/\.md$/, "");
  const checked: Snippet[] = [];
  const layers: Layer[] = [];
  const unresolvablePromotions: string[] = [];
  let partial = 0;
  let index = 0;

  // Every explicit `./x.ts` specifier the page imports, so a `.ts` fence that
  // has to be compiled as `.tsx` can be reported rather than silently elided.
  const tsSpecifiers = new Set(
    raw.flatMap((fence) =>
      [...fence.code.matchAll(/from\s+"[^"]*?([^"/]+\.ts)"/g)].map((match) => match[1]),
    ),
  );

  /** Path -> the fence currently defining it, in page order. */
  const current = new Map<string, RawFence & { relative: string }>();
  let introduced: string[] = [];

  const closeLayer = () => {
    if (current.size === 0) return;
    const dir = join(workDir, slug, layers.length === 0 ? "." : `__layer-${layers.length}`);
    const roots: string[] = [];
    const reported = new Map<string, Snippet>();
    for (const [relative, fence] of current) {
      const file = join(dir, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${asModule(fence.code)}\n`, "utf-8");
      roots.push(file);
      if (introduced.includes(relative)) {
        const snippet = { page, line: fence.line, label: fence.label, file };
        reported.set(file, snippet);
        checked.push(snippet);
      }
    }
    layers.push({ roots, reported });
    introduced = [];
  };

  for (const fence of raw) {
    if (fence.label === "\0partial") {
      partial++;
      continue;
    }

    if (fence.label.includes("..")) {
      throw new Error(
        `${page}:${fence.line} has a fence label that escapes the page: ${fence.label}`,
      );
    }

    const declared = fence.label ? extname(fence.label) : `.${fence.lang}`;
    const ext = preferTsx(fence.code, declared) ? ".tsx" : declared;

    // Labelled fences land at their declared path so a page's own relative
    // imports resolve; unlabelled ones have no path to claim.
    const base = fence.label ? fence.label.replace(/^\.?\//, "").slice(0, -declared.length) : "";
    const relative = fence.label ? `${base}${ext}` : `__fence-${index++}${ext}`;

    if (
      fence.label &&
      ext !== declared &&
      tsSpecifiers.has(`${base.split("/").pop()}${declared}`)
    ) {
      unresolvablePromotions.push(
        `${page}:${fence.line} [${fence.label}] contains JSX so it compiles as ${ext}, ` +
          `but the page imports it as "${declared}"`,
      );
    }

    if (current.has(relative)) closeLayer();
    current.set(relative, { ...fence, relative });
    introduced.push(relative);
  }
  closeLayer();

  return { layers, checked, partial, unrecognized, unresolvablePromotions };
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
const ambientFile = join(workDir, "__cloudflare.d.ts");
writeFileSync(ambientFile, CLOUDFLARE_AMBIENT, "utf-8");

const extracted = new Map(pages.map((page) => [page, extractSnippets(page)]));

// One host across every program: parsing lib.d.ts and the whole `@pracht/core`
// source graph once instead of eleven times is the difference between a second
// and a minute.
const baseHost = ts.createCompilerHost(options, true);
const sourceFileCache = new Map<string, ts.SourceFile | undefined>();
const workDirPrefix = `${posix(workDir)}/`;
const host: ts.CompilerHost = {
  ...baseHost,
  getSourceFile(fileName, languageVersion, onError, shouldCreate) {
    // Snippet files are per-page and rewritten between runs; nothing else is.
    if (posix(fileName).startsWith(workDirPrefix)) {
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

/**
 * Codes for "cannot find name X": plain, with a spelling suggestion, and the
 * "install @types for a test runner" variant.
 */
const UNRESOLVED_NAME = new Set([2304, 2552, 2593]);

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * A pracht export the name is one or two edits away from, if any.
 *
 * The budget scales with length because the alternative is false positives on
 * the short elided identifiers recipes are full of: `it` is one edit from
 * `t` (a real `@pracht/i18n` export) and is obviously not a typo of it. A
 * twelve-character `useRevalidat` is.
 */
function nearMissOfExport(name: string): string | undefined {
  const budget = name.length >= 8 ? 2 : name.length >= 5 ? 1 : 0;
  if (budget === 0) return undefined;
  for (const candidate of exportNames) {
    if (Math.abs(candidate.length - name.length) > budget) continue;
    if (levenshtein(name, candidate) <= budget) return candidate;
  }
  return undefined;
}

function isElision(diagnostic: ts.Diagnostic): boolean {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (UNRESOLVED_NAME.has(diagnostic.code)) {
    const name = /Cannot find name '([^']+)'/.exec(text)?.[1];
    if (name === undefined) return false;
    if (exportNames.has(name)) return false;
    const suggested = /Did you mean '([^']+)'\?/.exec(text)?.[1];
    if (suggested !== undefined && exportNames.has(suggested)) return false;
    return nearMissOfExport(name) === undefined;
  }
  if (diagnostic.code === 2307) {
    const specifier = /Cannot find module '([^']+)'/.exec(text)?.[1];
    return specifier !== undefined && !PRACHT_MODULE.test(specifier);
  }
  return false;
}

/**
 * `Register` is how an app tells the framework what `context` holds, and an
 * augmentation whose type collapses to `any` documents nothing: every later
 * `context.whatever` in the page then typechecks, including the ones that are
 * wrong. So each augmented property — and each member of an inline object
 * literal — has to resolve to a real type.
 */
function registerProblems(
  program: ts.Program,
  files: Map<string, Snippet>,
  describeAt: (snippet: Snippet, node: ts.Node) => string,
): string[] {
  const checker = program.getTypeChecker();
  const problems: string[] = [];

  const check = (snippet: Snippet, member: ts.TypeElement) => {
    if (!ts.isPropertySignature(member) || !member.type) return;
    const report = (node: ts.Node, name: string) => {
      problems.push(
        `${describeAt(snippet, node)}: Register augmentation property "${name}" is \`any\` — ` +
          "the type it names does not resolve, so nothing downstream is checked",
      );
    };
    const name = member.name.getText();
    if (ts.isTypeLiteralNode(member.type)) {
      for (const inner of member.type.members) {
        if (!ts.isPropertySignature(inner) || !inner.type) continue;
        if (checker.getTypeAtLocation(inner.type).flags & ts.TypeFlags.Any) {
          report(inner, `${name}.${inner.name.getText()}`);
        }
      }
      return;
    }
    if (checker.getTypeAtLocation(member.type).flags & ts.TypeFlags.Any) report(member, name);
  };

  for (const [file, snippet] of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    for (const statement of source.statements) {
      if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue;
      if (!statement.name.text.startsWith("@pracht/")) continue;
      const body = statement.body;
      if (!body || !ts.isModuleBlock(body)) continue;
      for (const declaration of body.statements) {
        if (!ts.isInterfaceDeclaration(declaration) || declaration.name.text !== "Register") {
          continue;
        }
        for (const member of declaration.members) check(snippet, member);
      }
    }
  }
  return problems;
}

/** Compiles one layer and returns the diagnostics worth reading. */
function diagnose(reported: Map<string, Snippet>, roots: string[] = []): string[] {
  if (reported.size === 0) return [];
  const program = ts.createProgram({
    rootNames: [ambientFile, ...new Set([...roots, ...reported.keys()])],
    options,
    host,
  });
  const byPath = new Map([...reported].map(([file, snippet]) => [posix(resolve(file)), snippet]));
  const messages: string[] = [];

  const describeAt = (snippet: Snippet, node: ts.Node) => {
    const source = node.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return (
      `  ${snippet.page}:${snippet.line}${snippet.label ? ` [${snippet.label}]` : ""} ` +
      `(fence line ${line + 1})`
    );
  };

  for (const diagnostic of [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]) {
    if (!diagnostic.file) continue;
    const snippet = byPath.get(posix(resolve(diagnostic.file.fileName)));
    if (!snippet || isElision(diagnostic)) continue;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    messages.push(
      `  ${snippet.page}:${snippet.line}${snippet.label ? ` [${snippet.label}]` : ""} ` +
        `(fence line ${line + 1}): TS${diagnostic.code} ` +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    );
  }

  messages.push(...registerProblems(program, reported, describeAt));
  return messages;
}

function checkPage(page: string): string[] {
  return extracted.get(page)!.layers.flatMap((layer) => diagnose(layer.reported, layer.roots));
}

const results = new Map(pages.map((page) => [page, checkPage(page)]));

/** Runs one synthetic fence through the same pipeline, for testing the test. */
function checkSource(name: string, code: string): string[] {
  const dir = join(workDir, "__selftest");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.tsx`);
  writeFileSync(file, `${asModule(code)}\n`, "utf-8");
  return diagnose(new Map([[file, { page: name, line: 1, label: "", file }]]));
}

describe("recipes-*.md code fences", () => {
  it("resolves every @pracht/* entry point named by the root tsconfig", () => {
    expect(entryPoints.length).toBeGreaterThan(10);
    // Without these the missing-import rule silently degrades to "allow
    // everything", and the whole suite passes while checking nothing.
    expect(exportNames.has("Form")).toBe(true);
    expect(exportNames.has("ApiRouteArgs")).toBe(true);
    expect(exportNames.has("defineApp")).toBe(true);
    expect(exportNames.has("useRevalidate")).toBe(true);
  });

  it("understands the info string of every ts/tsx fence", () => {
    const unrecognized = pages.flatMap((page) => extracted.get(page)!.unrecognized);
    expect(unrecognized.join("\n")).toBe("");
  });

  it("can resolve every fence a page imports by an explicit .ts path", () => {
    const unresolvable = pages.flatMap((page) => extracted.get(page)!.unresolvablePromotions);
    expect(unresolvable.join("\n")).toBe("");
  });

  it("finds fences to check", () => {
    const total = pages.reduce((sum, page) => sum + extracted.get(page)!.checked.length, 0);
    expect(total).toBeGreaterThan(60);
  });

  // The suppression rule is the whole design, and it fails open: get it wrong
  // and every page passes while nothing is checked.
  describe("the suppression rule", () => {
    it("passes an app helper the recipe deliberately elides", () => {
      expect(checkSource("elided", "await sendContactEmail({ name: 'a' });").join("\n")).toBe("");
    });

    it("passes a module the recipe deliberately elides", () => {
      expect(
        checkSource("elided-module", 'import { db } from "./db";\ndb.query();').join("\n"),
      ).toBe("");
    });

    it("fails an unimported pracht export", () => {
      const messages = checkSource("missing-import", "export function GET(_: ApiRouteArgs) {}");
      expect(messages.join("\n")).toMatch(/Cannot find name 'ApiRouteArgs'/);
    });

    it("fails a typo of a pracht export", () => {
      const messages = checkSource("typo", 'import "@pracht/core";\nuseRevalidat();');
      expect(messages.join("\n")).toMatch(/Cannot find name 'useRevalidat'/);
    });

    it("passes correct usage of the same export", () => {
      expect(
        checkSource(
          "correct",
          'import { useRevalidate } from "@pracht/core";\nexport const r = useRevalidate;',
        ).join("\n"),
      ).toBe("");
    });

    it("fails a Register augmentation whose type does not resolve", () => {
      const messages = checkSource(
        "register-any",
        [
          'import "@pracht/core";',
          'import type { Logger } from "./elided";',
          'declare module "@pracht/core" {',
          "  interface Register {",
          "    context: { logger: Logger };",
          "  }",
          "}",
        ].join("\n"),
      );
      expect(messages.join("\n")).toMatch(/context\.logger" is `any`/);
    });
  });

  for (const page of pages.filter((page) => !PENDING_PAGES.has(page))) {
    const { checked, partial } = extracted.get(page)!;
    it(`typechecks ${page} (${checked.length} fences, ${partial} partial)`, () => {
      expect(results.get(page)!.join("\n")).toBe("");
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
