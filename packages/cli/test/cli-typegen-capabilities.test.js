import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";

import {
  capabilitiesDistTypesPath,
  cleanupTempDirs,
  coreDistTypesPath,
  createRepoTempDir,
  runCli,
  standardSchemaImportPath,
  typecheckFixture,
  virtualTypesPath,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli typegen capabilities", () => {
  it("generates capability declarations from capability schemas", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-capabilities-");
    writeTypedManifestApp(appDir, { capabilities: true });

    const result = JSON.parse(runCli(["typegen", "--json"], { cwd: appDir }).stdout);
    const declaration = readFileSync(join(appDir, "src/pracht-capabilities.d.ts"), "utf-8");

    expect(result).toMatchObject({
      capabilities: 4,
      files: ["src/pracht.d.ts", "src/pracht-routes.ts", "src/pracht-capabilities.d.ts"],
      ok: true,
    });
    expect(declaration).toContain('declare module "@pracht/core"');
    // Input: `limit` declares a default, so callers may omit it.
    expect(declaration).toContain('"notes.search": {');
    expect(declaration).toContain('input: { "query": string; "limit"?: number; };');
    // Output: open objects keep an index signature; closed ones do not.
    expect(declaration).toContain(
      'output: { "notes": Array<Record<string, unknown>>; [key: string]: unknown; };',
    );
    expect(declaration).toContain('"notes.set-status": {');
    expect(declaration).toContain('"status": "draft" | "published";');
    expect(declaration).toContain('output: { "updated": true; };');

    // The effect class and exposure drive the typed client: `destructive`
    // requires a confirmation token and private capabilities are unreachable
    // from the browser, so both have to reach the registration.
    expect(declaration).toContain('effect: "read";');
    expect(declaration).toContain('effect: "destructive";');
    expect(declaration).toContain("exposed: { http: true; webmcp: false; mcp: false };");
    // notes.set-status declares no `expose` — it stays private.
    expect(declaration).toContain("exposed: { http: false; webmcp: false; mcp: false };");
    // Contract prose becomes JSDoc so hovering a name shows what an agent reads.
    expect(declaration).toContain("* Search notes");
    expect(declaration).toContain("* Find notes matching a query.");
    expect(declaration).toContain("capabilityClient: {");
    expect(declaration).toContain('"notes": {');
    expect(declaration).toContain('"search": CapabilityClientMethod<"notes.search">;');

    const hoverPath = join(appDir, "src/capability-hover.ts");
    writeProjectFile(
      appDir,
      "src/capability-hover.ts",
      `import { capabilities } from "virtual:pracht/capabilities";
capabilities.notes.search({ query: "roadmap" });
`,
    );
    const hoverProgram = ts.createProgram(
      [hoverPath, join(appDir, "src/pracht-capabilities.d.ts"), virtualTypesPath],
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        paths: {
          "@pracht/core": [coreDistTypesPath],
          "@pracht/capabilities": [capabilitiesDistTypesPath],
          "@standard-schema/spec": [standardSchemaImportPath],
        },
      },
    );
    const hoverSource = hoverProgram.getSourceFile(hoverPath);
    const hoverChecker = hoverProgram.getTypeChecker();
    let searchProperty;
    const findSearchProperty = (node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "search") {
        searchProperty = node.name;
      }
      ts.forEachChild(node, findSearchProperty);
    };
    findSearchProperty(hoverSource);
    const searchSymbol = hoverChecker.getSymbolAtLocation(searchProperty);
    expect(ts.displayPartsToString(searchSymbol.getDocumentationComment(hoverChecker))).toBe(
      "Search notes\n\nFind notes matching a query.",
    );

    const check = JSON.parse(runCli(["typegen", "--check", "--json"], { cwd: appDir }).stdout);
    expect(check).toMatchObject({ capabilities: 4, check: true, ok: true });

    // Removing every capability rewrites the existing file to the empty
    // registration instead of leaving it stale.
    writeTypedManifestApp(appDir, { capabilities: false });
    const emptied = JSON.parse(runCli(["typegen", "--json"], { cwd: appDir }).stdout);
    expect(emptied).toMatchObject({ capabilities: 0, ok: true });
    expect(readFileSync(join(appDir, "src/pracht-capabilities.d.ts"), "utf-8")).toContain(
      "capabilities: Record<never, never>;",
    );
  }, 30_000);

  it("keeps all-private capability registrations out of browser client types", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-private-capability-types-");
    writeTypedManifestApp(appDir, { capabilities: true });

    const manifestPath = join(appDir, "src/routes.ts");
    const manifest = readFileSync(manifestPath, "utf-8").replace(
      /  capabilities: \{[\s\S]*?\n  \},/,
      `  capabilities: {
    "notes.set-status": () => import("./capabilities/notes-set-status.ts"),
  },`,
    );
    writeFileSync(manifestPath, manifest, "utf-8");
    runCli(["typegen"], { cwd: appDir });

    writeProjectFile(
      appDir,
      "src/private-capability-consumer.tsx",
      `import { Form } from "@pracht/core";
import { callCapability, capabilities } from "virtual:pracht/capabilities";

// @ts-expect-error - the only registered capability has no HTTP endpoint
callCapability("notes.set-status", { id: "1", status: "draft" });

// @ts-expect-error - an all-private app has an empty nested browser client
capabilities.notes["set-status"]({ id: "1", status: "draft" });

// @ts-expect-error - capability forms also require an HTTP-exposed name
const form = <Form capability="notes.set-status" />;
`,
    );
    writeProjectFile(
      appDir,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            allowImportingTsExtensions: true,
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            jsx: "react-jsx",
            jsxImportSource: "preact",
            types: ["node"],
            paths: {
              "@pracht/core": [coreDistTypesPath],
              "@pracht/capabilities": [capabilitiesDistTypesPath],
              "@standard-schema/spec": [standardSchemaImportPath],
            },
          },
          files: [virtualTypesPath],
          include: ["src"],
        },
        null,
        2,
      ),
    );

    typecheckFixture(appDir);
  }, 60_000);
});
