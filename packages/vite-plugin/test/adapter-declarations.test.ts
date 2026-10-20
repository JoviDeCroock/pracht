import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

// R446-1: a user package that exports an unannotated adapter value has to emit
// declarations naming the adapter contract (TS4023 otherwise). This compiles a
// probe against the adapters' *built* declarations, the way an app sees them.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADAPTERS = [
  ["node", "nodeAdapter"],
  ["cloudflare", "cloudflareAdapter"],
  ["netlify", "netlifyAdapter"],
  ["vercel", "vercelAdapter"],
  ["static", "staticAdapter"],
] as const;

const tempRoot = resolve(repoRoot, ".tmp");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function dist(pkg: string, file: string): string {
  return resolve(repoRoot, "packages", pkg, "dist", file);
}

const built = ADAPTERS.every(([id]) => existsSync(dist(`adapter-${id}`, "index.d.mts")));

describe.skipIf(!built)("adapter declarations", () => {
  it("let a package emit declarations for unannotated adapter values", () => {
    mkdirSync(tempRoot, { recursive: true });
    const dir = mkdtempSync(join(tempRoot, "adapter-declarations-"));
    dirs.push(dir);
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      [
        'import type { PrachtAdapter } from "@pracht/core/adapter";',
        'import type { PrachtAdapter as PluginAdapter } from "@pracht/vite-plugin";',
        ...ADAPTERS.map(([id, factory]) => `import { ${factory} } from "@pracht/adapter-${id}";`),
        ...ADAPTERS.flatMap(([id, factory]) => [
          `export const ${id}Inferred = ${factory}();`,
          `export function ${id}Wrapped() { return ${factory}(); }`,
          `export const ${id}Annotated: PrachtAdapter = ${factory}();`,
          `export const ${id}PluginAnnotated: PluginAdapter = ${factory}();`,
          "// @ts-expect-error -- an adapter is not a string",
          `export const ${id}NotAString: string = ${factory}();`,
        ]),
        "",
      ].join("\n"),
    );

    const paths: Record<string, string[]> = {
      "@pracht/core": [dist("framework", "index.d.mts")],
      "@pracht/core/*": [dist("framework", "*.d.mts")],
      "@pracht/vite-plugin": [dist("vite-plugin", "index.d.mts")],
      ...Object.fromEntries(
        ADAPTERS.map(([id]) => [`@pracht/adapter-${id}`, [dist(`adapter-${id}`, "index.d.mts")]]),
      ),
    };
    const program = ts.createProgram([probe], {
      declaration: true,
      emitDeclarationOnly: true,
      outDir: join(dir, "out"),
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [resolve(repoRoot, "node_modules/@types")],
      paths,
    });
    const result = program.emit();
    const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].map(
      (diagnostic) =>
        `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
    expect(diagnostics).toEqual([]);
  });
});
