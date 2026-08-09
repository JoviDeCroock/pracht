import { afterEach, describe, it } from "vitest";

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

describe("@pracht/cli typegen api types", () => {
  it("generated api route types drive apiFetch end to end", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-api-types-");
    writeTypedManifestApp(appDir);
    runCli(["typegen"], { cwd: appDir });

    writeProjectFile(
      appDir,
      "src/api-consumer.ts",
      `import { apiFetch, defineApi } from "@pracht/core";

export async function main() {
  // Params are required, convenient primitive inputs are stringified for the
  // wire, and transformed schema output reaches the handler response type.
  const item = await apiFetch("/api/items/:id", { params: { id: 1 } });
  const _item: { id: number } = item;

  // HEAD responses are always bodyless regardless of the handler return type.
  const head = await apiFetch("/api/items/:id", { method: "HEAD", params: { id: "1" } });
  const _head: undefined = head;

  // @ts-expect-error - GET and HEAD requests cannot carry bodies
  await apiFetch("/api/items/:id", { method: "HEAD", params: { id: "1" }, body: "nope" });

  // @ts-expect-error - route params arrive as strings, so a number-only schema cannot validate
  await apiFetch("/api/items/:id", { method: "DELETE", params: { id: 1 } });

  // Body is typed by the route's Standard Schema input.
  const created = await apiFetch("/api/items", { method: "POST", body: { name: "x" } });
  const _created: { created: string } = created;

  // @ts-expect-error - omitting method always means GET, never an inferred mutation
  await apiFetch("/api/items", { body: { name: "x" } });

  // A successful Response branch makes the parsed output unknowable.
  const mixed = await apiFetch("/api/items", { method: "PUT", body: { id: 1 } });
  // @ts-expect-error - mixed Response/JSON handlers have unknown output
  const _mixed: { updated: boolean } = mixed;

  const mutationMethod = Math.random() > 0.5 ? "POST" as const : "PUT" as const;
  // @ts-expect-error - a union method must stay correlated with its body shape
  await apiFetch("/api/items", { method: mutationMethod, body: { name: "x" } });

  // @ts-expect-error - inferred JSON outputs must survive serialization unchanged
  defineApi({ handler: () => ({ createdAt: new Date() }) });
  // @ts-expect-error - undefined is not a top-level JSON value
  defineApi({ handler: () => undefined });

  // A default handler remains available for methods without a named override.
  const fallback = await apiFetch("/api/items/:id", { method: "PATCH", params: { id: "1" } });
  const _fallback: unknown = fallback;

  // @ts-expect-error - unknown api path
  await apiFetch("/api/nope");

  // @ts-expect-error - missing required params
  await apiFetch("/api/items/:id");

  // @ts-expect-error - body must match the schema input
  await apiFetch("/api/items", { method: "POST", body: { name: 1 } });

  // @ts-expect-error - POST requires a body
  await apiFetch("/api/items", { method: "POST" });

  // @ts-expect-error - GET is not exported for /api/items
  await apiFetch("/api/items", { method: "GET" });

  // json() handlers keep their payload type (and status freedom) on the client.
  const uploaded = await apiFetch("/api/uploads", {
    method: "POST",
    body: { name: "x", avatar: new File([], "a.png") },
  });
  const _uploaded: { uploaded: string } = uploaded;

  // File-bearing body schemas accept FormData as the wire format.
  await apiFetch("/api/uploads", { method: "POST", body: new FormData() });

  // String query inputs stay fully typed.
  const results = await apiFetch("/api/uploads", { query: { q: "boots" } });
  const _results: { results: string[] } = results;

  // @ts-expect-error - query values arrive as strings; a number input can never validate
  await apiFetch("/api/uploads", { query: { q: "boots", page: 2 } });
}
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
            types: ["node", "vite/client"],
            paths: {
              "@pracht/core": [coreDistTypesPath],
              "@standard-schema/spec": [standardSchemaImportPath],
            },
          },
          include: ["src"],
        },
        null,
        2,
      ),
    );

    // Throws (non-zero exit) when the generated declaration fails to
    // deliver end-to-end api types.
    typecheckFixture(appDir);
  }, 60_000);

  it("keeps the nested capability client usable before typegen", () => {
    const appDir = createRepoTempDir("pracht-cli-untyped-capability-client-");

    writeProjectFile(
      appDir,
      "src/capability-consumer.ts",
      `import { capabilities } from "virtual:pracht/capabilities";

export async function browser() {
  const result = await capabilities.notes.search<{ notes: string[] }>({ query: "roadmap" });
  if (result.ok) {
    const _notes: string[] = result.data.notes;
  }

  const namespace = Math.random() > 0.5 ? "notes" : "projects";
  await capabilities[namespace].search({ query: "dynamic" });
}
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
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
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
