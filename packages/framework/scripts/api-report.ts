// Generates the @pracht/core API report: every name each public subpath
// exports, with its kind, one per line, sorted. The report is checked in at
// packages/framework/api-report.api.md so a change to the public surface shows
// up in review as a diff of that file.
//
//   node packages/framework/scripts/api-report.ts           print the report
//   node packages/framework/scripts/api-report.ts --update  rewrite the file
//   node packages/framework/scripts/api-report.ts --check   fail on drift
//
// `pnpm api:update` runs the second form. The check also runs as a unit test
// (test/api-report.test.ts), so CI and `pnpm run verify` enforce it.
//
// Every subpath in package.json "exports" is reported, including the ones
// only generated code imports (islands-client, devtools, ...): they ship, and
// an app built with one vite-plugin version imports them from another core
// version. Exports whose declaration carries `@internal` are listed with that
// tag rather than hidden, so an internal export becoming public (or the
// reverse) is visible too.
//
// It reads the TypeScript sources tsdown compiles (dist/<name>.d.mts comes
// from src/<name>.ts), so it needs no build and cannot read a stale dist/.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");

export const API_REPORT_PATH = join(packageDir, "api-report.api.md");
export const API_REPORT_UPDATE_COMMAND = "pnpm api:update";

interface EntryPoint {
  /** Source file tsdown compiles into the declared types file. */
  source: string;
  /** Import specifiers (with condition, when not the default) that resolve to it. */
  specifiers: string[];
}

type ExportTarget = string | { [condition: string]: ExportTarget };

function collectTypesTargets(
  target: ExportTarget,
  conditions: string[],
  out: Array<{ conditions: string[]; types: string }>,
): void {
  if (typeof target === "string") return;
  for (const [condition, value] of Object.entries(target)) {
    if (condition === "types" && typeof value === "string") {
      out.push({ conditions, types: value });
    } else if (typeof value === "object") {
      collectTypesTargets(value, [...conditions, condition], out);
    }
  }
}

export function readEntryPoints(): EntryPoint[] {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as {
    name: string;
    exports: Record<string, ExportTarget>;
  };
  const bySource = new Map<string, EntryPoint>();
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const found: Array<{ conditions: string[]; types: string }> = [];
    collectTypesTargets(target, [], found);
    if (found.length === 0) {
      throw new Error(`api-report: package.json exports["${subpath}"] declares no "types" file.`);
    }
    for (const { conditions, types } of found) {
      const match = /^\.\/dist\/(.+)\.d\.mts$/.exec(types);
      const source = match
        ? ["ts", "tsx"]
            .map((ext) => `src/${match[1]}.${ext}`)
            .find((file) => existsSync(join(packageDir, file)))
        : undefined;
      if (!source) {
        throw new Error(
          `api-report: cannot map types file "${types}" (exports["${subpath}"]) to a source file under src/.`,
        );
      }
      const specifier = pkg.name + subpath.slice(1);
      const label = conditions.length > 0 ? `${specifier} [${conditions.join(", ")}]` : specifier;
      const entry = bySource.get(source) ?? { source, specifiers: [] };
      entry.specifiers.push(label);
      bySource.set(source, entry);
    }
  }
  return [...bySource.values()];
}

function isTypeOnlyAlias(declaration: ts.Declaration): boolean {
  if (ts.isExportSpecifier(declaration)) {
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  }
  if (ts.isImportSpecifier(declaration)) {
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  }
  if (ts.isImportClause(declaration)) return declaration.isTypeOnly;
  if (ts.isNamespaceImport(declaration)) return declaration.parent.isTypeOnly;
  if (ts.isNamespaceExport(declaration)) return declaration.parent.isTypeOnly;
  return false;
}

/** Follows an export's alias chain; type-only if any link is `export type`/`import type`. */
function resolveExport(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): { target: ts.Symbol; typeOnly: boolean } {
  let current = symbol;
  let typeOnly = false;
  const seen = new Set<ts.Symbol>();
  while (current.flags & ts.SymbolFlags.Alias && !seen.has(current)) {
    seen.add(current);
    if (current.declarations?.some(isTypeOnlyAlias)) typeOnly = true;
    current = checker.getImmediateAliasedSymbol(current) ?? checker.getAliasedSymbol(current);
  }
  return { target: current, typeOnly };
}

const KINDS: Array<[ts.SymbolFlags, string]> = [
  [ts.SymbolFlags.Class, "class"],
  [ts.SymbolFlags.Function, "function"],
  [ts.SymbolFlags.Enum, "enum"],
  [ts.SymbolFlags.Variable, "const"],
  [ts.SymbolFlags.Module, "namespace"],
  [ts.SymbolFlags.Interface, "interface"],
  [ts.SymbolFlags.TypeAlias, "type"],
];

function describeKind(target: ts.Symbol, typeOnly: boolean): string {
  let kinds = KINDS.filter(([flag]) => target.flags & flag).map(([, kind]) => kind);
  if (kinds.includes("class") || kinds.includes("enum")) {
    kinds = kinds.filter((kind) => kind !== "interface" && kind !== "namespace");
  }
  if (kinds.includes("const") && target.flags & ts.SymbolFlags.FunctionScopedVariable) {
    kinds = kinds.map((kind) => (kind === "const" ? "var" : kind));
  } else if (kinds.includes("const")) {
    const declaration = target.declarations?.find(ts.isVariableDeclaration);
    const list = declaration?.parent;
    if (list && ts.isVariableDeclarationList(list) && !(list.flags & ts.NodeFlags.Const)) {
      kinds = kinds.map((kind) => (kind === "const" ? "let" : kind));
    }
  }
  const kind = kinds.length > 0 ? kinds.join(" + ") : "unknown";
  const hasValue = (target.flags & ts.SymbolFlags.Value) !== 0;
  return typeOnly && hasValue ? `${kind} (type-only export)` : kind;
}

function isInternal(target: ts.Symbol): boolean {
  return (target.declarations ?? []).some((declaration) =>
    ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === "internal"),
  );
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function generateApiReport(): string {
  const entries = readEntryPoints();
  const configPath = join(repoRoot, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error(`api-report: cannot read ${configPath}`);
  const program = ts.createProgram(
    entries.map((entry) => join(packageDir, entry.source)),
    { ...parsed.options, noEmit: true },
  );
  const checker = program.getTypeChecker();

  const lines = [
    "# @pracht/core API report",
    "",
    `<!-- Generated by \`${API_REPORT_UPDATE_COMMAND}\` (packages/framework/scripts/api-report.ts). Do not edit by hand. -->`,
    "",
    "Every name each public entry point of `@pracht/core` exports, with its kind.",
    "A change to this file is a change to the published API: give it a changeset",
    "with the semver bump it deserves.",
  ];

  const sorted = [...entries].sort((a, b) => compareCodePoints(a.specifiers[0]!, b.specifiers[0]!));
  for (const entry of sorted) {
    const file = join(packageDir, entry.source);
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    const exportLines = moduleSymbol
      ? checker
          .getExportsOfModule(moduleSymbol)
          .map((symbol) => {
            const { target, typeOnly } = resolveExport(checker, symbol);
            const internal = isInternal(target) ? " @internal" : "";
            return `${symbol.name}: ${describeKind(target, typeOnly)}${internal}`;
          })
          .sort(compareCodePoints)
      : [];
    lines.push(
      "",
      `## ${entry.specifiers.map((specifier) => `\`${specifier}\``).join(", ")}`,
      "",
      `Source: \`${relative(repoRoot, file).split("\\").join("/")}\``,
      "",
      "```text",
      ...exportLines,
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Export lines added to / removed from `expected` in `actual`, prefixed with their section. */
export function diffApiReports(
  expected: string,
  actual: string,
): { added: string[]; removed: string[] } {
  const index = (report: string) => {
    const out = new Set<string>();
    let section = "";
    for (const line of report.split("\n")) {
      if (line.startsWith("## ")) section = line.slice(3);
      else if (/^[^\s`#<].*: /.test(line)) out.add(`${section}  ${line}`);
    }
    return out;
  };
  const before = index(expected);
  const after = index(actual);
  return {
    added: [...after].filter((line) => !before.has(line)),
    removed: [...before].filter((line) => !after.has(line)),
  };
}

export function describeApiReportDrift(expected: string, actual: string): string {
  const { added, removed } = diffApiReports(expected, actual);
  const parts = [
    "The @pracht/core public API no longer matches packages/framework/api-report.api.md.",
  ];
  if (added.length > 0) parts.push("Added:", ...added.map((line) => `  + ${line}`));
  if (removed.length > 0) parts.push("Removed:", ...removed.map((line) => `  - ${line}`));
  if (added.length === 0 && removed.length === 0)
    parts.push("(Entry points or report header changed.)");
  parts.push(
    `If the change is intended, run \`${API_REPORT_UPDATE_COMMAND}\`, commit the report, and add a changeset with the matching semver bump.`,
  );
  return parts.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = generateApiReport();
  if (process.argv.includes("--update")) {
    writeFileSync(API_REPORT_PATH, report);
    console.log(`api-report: wrote ${relative(process.cwd(), API_REPORT_PATH)}`);
  } else if (process.argv.includes("--check")) {
    const current = existsSync(API_REPORT_PATH) ? readFileSync(API_REPORT_PATH, "utf-8") : "";
    if (current !== report) {
      console.error(describeApiReportDrift(current, report));
      process.exitCode = 1;
    }
  } else {
    process.stdout.write(report);
  }
}
