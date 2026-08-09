import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  capabilitiesDistTypesPath,
  cleanupTempDirs,
  coreDistTypesPath,
  createRepoTempDir,
  runCli,
  standardSchemaImportPath,
  tscPath,
  typecheckFixture,
  virtualTypesPath,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli generated capability types", () => {
  it("generated capability types make the client APIs type-safe end to end", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-capability-types-");
    writeTypedManifestApp(appDir, { capabilities: true });
    runCli(["typegen"], { cwd: appDir });

    writeProjectFile(
      appDir,
      "src/capability-consumer.ts",
      `import { createCapabilityTestHost, invokeCapability } from "@pracht/core";
import type { CapabilityTestHost } from "@pracht/core";
import { defineCapability } from "@pracht/capabilities";
import type { CapabilityRunArgs } from "@pracht/capabilities";
import { callCapability, capabilities, useCapability } from "virtual:pracht/capabilities";

declare const ctx: { request: Request };
declare const host: CapabilityTestHost;
declare const readName: "notes.search" | "notes.stats";
declare const mixedName: "notes.search" | "notes.stats";

const fixtureHost = createCapabilityTestHost({
  capabilities: {
    "fixture.only": defineCapability({
      title: "Fixture only",
      description: "A capability that exists only in this standalone test host.",
      input: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { seen: { type: "string" } },
        required: ["seen"],
        additionalProperties: false,
      },
      effect: "read",
      async run({ input }: CapabilityRunArgs<{ value: string }>) {
        return { seen: input.value };
      },
    }),
  },
});

export async function server() {
  // A factory-created host reads both generics retained on the capability
  // object. Typing run()'s input lets defineCapability infer its output.
  const fixture = await fixtureHost.invoke("fixture.only", { value: "roadmap" });
  if (fixture.ok) {
    const _seen: string = fixture.data.seen;
  }

  // @ts-expect-error - the inferred standalone-host input rejects mismatches
  await fixtureHost.invoke("fixture.only", { value: 42 });

  // Input and output both come from the registration — no per-call generics.
  const found = await invokeCapability("notes.search", { query: "roadmap" }, ctx);
  if (found.ok) {
    const _notes: Array<Record<string, unknown>> = found.data.notes;
  }

  // Private capabilities stay reachable from server code.
  const updated = await invokeCapability("notes.set-status", { id: "1", status: "draft" }, ctx);
  if (updated.ok) {
    const _updated: true = updated.data.updated;
  }

  // @ts-expect-error - a mismatched input no longer falls through to an untyped overload
  await invokeCapability("notes.search", { query: 42 }, ctx);

  // @ts-expect-error - a missing required property is a compile error
  await invokeCapability("notes.search", {}, ctx);

  // @ts-expect-error - unknown capability name
  await invokeCapability("notes.serach", { query: "x" }, ctx);

  // @ts-expect-error - an explicit type argument cannot re-open the untyped form
  await invokeCapability<{ notes: string[] }>("notes.search", { query: "x" }, ctx);

  // @ts-expect-error - enums narrow to their literal members
  await invokeCapability("notes.set-status", { id: "1", status: "archived" }, ctx);

  const serverName = Math.random() > 0.5 ? "notes.search" as const : "notes.set-status" as const;
  // @ts-expect-error - a union name cannot take input valid for only one possible capability
  await invokeCapability(serverName, { query: "roadmap" }, ctx);
}

export async function browser() {
  const found = await callCapability("notes.search", { query: "roadmap" });
  if (found.ok) {
    const _notes: Array<Record<string, unknown>> = found.data.notes;
  }

  // An empty input schema means the argument may be omitted entirely.
  const stats = await callCapability("notes.stats");
  if (stats.ok) {
    const _total: number = stats.data.total;
  }

  // Destructive calls make their two phases explicit: prepare obtains the
  // token without committing, then confirm commits the identical input.
  await callCapability("notes.purge", { titlePrefix: "tmp" }, { prepare: true });
  await callCapability("notes.purge", { titlePrefix: "tmp" }, { confirm: "token" });

  // @ts-expect-error - destructive calls must explicitly prepare or confirm
  await callCapability("notes.purge", { titlePrefix: "tmp" });

  // @ts-expect-error - one call cannot prepare and commit simultaneously
  await callCapability(
    "notes.purge",
    { titlePrefix: "tmp" },
    { prepare: true, confirm: "token" },
  );

  // @ts-expect-error - notes.set-status is private: there is no endpoint to call
  await callCapability("notes.set-status", { id: "1", status: "draft" });

  // @ts-expect-error - mismatched input
  await callCapability("notes.search", { query: 42 });

  // @ts-expect-error - unknown capability name
  await callCapability("notes.serach", { query: "x" });

  const browserName = Math.random() > 0.5 ? "notes.search" as const : "notes.stats" as const;
  // @ts-expect-error - stats may omit input, but search may not
  await callCapability(browserName);
  // @ts-expect-error - search input is not valid for every member of the name union
  await callCapability(browserName, { query: "roadmap" });

  const dynamic = useCapability(browserName);
  // @ts-expect-error - the bound name must be narrowed before supplying member-specific input
  await dynamic.call({ query: "roadmap" });
}

export async function client() {
  // Dotted names become nested namespaces on the generated client.
  const found = await capabilities.notes.search({ query: "roadmap" });
  if (found.ok) {
    const _notes: Array<Record<string, unknown>> = found.data.notes;
  }

  const stats = await capabilities.notes.stats();
  if (stats.ok) {
    const _total: number = stats.data.total;
  }

  await capabilities.notes.purge({ titlePrefix: "tmp" }, { prepare: true });
  await capabilities.notes.purge({ titlePrefix: "tmp" }, { confirm: "token" });
  await capabilities.notes.purge({ titlePrefix: "tmp" }, { prepare: true });

  // @ts-expect-error - destructive calls must explicitly prepare or confirm
  await capabilities.notes.purge({ titlePrefix: "tmp" });

  const purge = useCapability("notes.purge");
  await purge.call({ titlePrefix: "tmp" }, { prepare: true });
  await purge.call({ titlePrefix: "tmp" }, { confirm: "token" });
  // @ts-expect-error - the hook has the same destructive-call gate
  await purge.call({ titlePrefix: "tmp" });

  // @ts-expect-error - mismatched input
  await capabilities.notes.search({ query: 42 });

  // @ts-expect-error - private capabilities are absent from the browser client
  await capabilities.notes["set-status"]({ id: "1", status: "draft" });

  // @ts-expect-error - unknown capability
  await capabilities.notes.nope({});
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

    // Throws (non-zero exit) when any guarantee above stops holding — either a
    // valid call starts failing or an invalid one stops being rejected.
    typecheckFixture(appDir);

    // A current typegen file with no HTTP exposure is not a legacy file. Every
    // capability must stay absent from all browser projections.
    writeProjectFile(
      appDir,
      "src/routes.ts",
      `import { defineApp } from "@pracht/core";

export const app = defineApp({
  capabilities: {
    "notes.set-status": () => import("./capabilities/notes-set-status.ts"),
  },
  routes: [],
});
`,
    );
    runCli(["typegen"], { cwd: appDir });
    writeProjectFile(
      appDir,
      "src/capability-consumer.ts",
      `import { callCapability, capabilities, useCapability } from "virtual:pracht/capabilities";

export async function browser() {
  // @ts-expect-error - an all-private graph exposes no browser call names
  await callCapability("notes.set-status", { id: "1", status: "draft" });
  // @ts-expect-error - the nested client is empty for an all-private graph
  await capabilities.notes["set-status"]({ id: "1", status: "draft" });
  // @ts-expect-error - hooks cannot bind to private capabilities either
  useCapability("notes.set-status");
}
`,
    );

    typecheckFixture(appDir);

    // Removing the last capability leaves an intentionally empty generated
    // registration. That is still evidence typegen has run, so stale names
    // must not regain the pre-typegen untyped fallback.
    writeTypedManifestApp(appDir, { capabilities: false });
    runCli(["typegen"], { cwd: appDir });
    writeProjectFile(
      appDir,
      "src/capability-consumer.ts",
      `import { invokeCapability } from "@pracht/core";
import { callCapability, useCapability } from "virtual:pracht/capabilities";

declare const ctx: { request: Request };

export async function removed() {
  // @ts-expect-error - an emitted empty graph exposes no stale browser names
  await callCapability("notes.search", { query: "roadmap" });
  // @ts-expect-error - hooks cannot bind to a removed capability
  useCapability("notes.search");
  // @ts-expect-error - direct invocation also knows the generated graph is empty
  await invokeCapability("notes.search", { query: "roadmap" }, ctx);
}
`,
    );

    typecheckFixture(appDir);

    // A declaration generated before `effect`/`exposed` existed is committed in
    // real apps, so it cannot be regenerated on the user's behalf. It must keep
    // compiling exactly as it did: every registered name reachable from the
    // browser, no confirmation gate, unknown names still rejected. This file is
    // handwritten rather than generated precisely because no current typegen
    // can emit it.
    writeProjectFile(
      appDir,
      "src/pracht-capabilities.d.ts",
      `import "@pracht/core";

declare module "@pracht/core" {
  interface Register {
    capabilities: {
      "notes.search": {
        input: { "query": string; };
        output: { "notes": string[]; };
      };
      "notes.purge": {
        input: { "titlePrefix": string; };
        output: { "purged": number; };
      };
      "notes.set-status": {
        input: { "id": string; };
        output: { "updated": true; };
      };
    };
  }
}
`,
    );
    writeProjectFile(
      appDir,
      "src/capability-consumer.ts",
      `import { invokeCapability } from "@pracht/core";
import { callCapability, capabilities, useCapability } from "virtual:pracht/capabilities";

declare const ctx: { request: Request };

export async function legacyDeclaration() {
  // Input and output types still apply — those fields have always been there.
  const found = await callCapability("notes.search", { query: "roadmap" });
  if (found.ok) {
    const _notes: string[] = found.data.notes;
  }
  await invokeCapability("notes.search", { query: "roadmap" }, ctx);

  // No \`effect\` recorded, so the confirmation gate cannot close. Demanding a
  // token here would break every app upgrading with a committed declaration.
  await callCapability("notes.purge", { titlePrefix: "tmp" });
  const purge = useCapability("notes.purge");
  await purge.call({ titlePrefix: "tmp" });

  // No \`exposed\` recorded, so exposure goes unchecked and every registered
  // name stays reachable — as it was before the field existed.
  await callCapability("notes.set-status", { id: "1" });
  await capabilities.notes["set-status"]({ id: "1" });

  // @ts-expect-error - unknown names are rejected even by a legacy declaration
  await callCapability("notes.serach", { query: "roadmap" });
  // @ts-expect-error - and mismatched inputs still are too
  await callCapability("notes.search", { query: 42 });
}
`,
    );

    typecheckFixture(appDir);
  }, 60_000);

  it("names the valid capabilities when a call does not resolve", () => {
    // Both lines below are compile errors under any of these designs, so only
    // the message distinguishes them and only an assertion on the message keeps
    // it from regressing. Gating the untyped form by resolving its `name` to
    // `never` left that signature in place to absorb whatever arity filtering
    // rejected, reporting every mistake as "not assignable to type 'never'";
    // making one signature's arity depend on the name reported every mistake as
    // an argument count. Splitting by effect class means an unresolved name is
    // always arity-compatible with the first signature, which answers with the
    // set of names that would have worked.
    const appDir = createRepoTempDir("pracht-cli-typegen-capability-messages-");
    writeTypedManifestApp(appDir, { capabilities: true });
    runCli(["typegen"], { cwd: appDir });

    writeProjectFile(
      appDir,
      "src/capability-consumer.ts",
      `import { callCapability } from "virtual:pracht/capabilities";

export async function mistakes() {
  await callCapability("notes.serach", { query: "roadmap" });
  await callCapability("notes.purge", { titlePrefix: "tmp" });
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

    let diagnostics = "";
    try {
      execFileSync(process.execPath, [tscPath, "-p", ".", "--pretty", "false"], {
        cwd: appDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      throw new Error("expected the consumer to fail typechecking");
    } catch (error) {
      diagnostics = error.stdout || error.stderr || "";
    }

    // Nothing is reported against `never`, and nothing is reported as an
    // argument count — both of those hide which name the compiler wanted.
    expect(diagnostics).not.toContain("parameter of type 'never'");
    expect(diagnostics).not.toContain("Expected 3 arguments, but got 2");
    // The misspelled name is answered with the names that would have worked.
    expect(diagnostics).toContain(
      `error TS2345: Argument of type '"notes.serach"' is not assignable to parameter of type '"notes.search" | "notes.stats"'`,
    );
    // A destructive name is excluded from that same set, which is how "this
    // one needs prepare/confirm" surfaces. Blunter than naming the rule, but it
    // points at a real, listed distinction rather than at `never`.
    expect(diagnostics).toContain(
      `error TS2345: Argument of type '"notes.purge"' is not assignable to parameter of type '"notes.search" | "notes.stats"'`,
    );
  }, 60_000);
});
