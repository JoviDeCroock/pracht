import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_DEFAULTS } from "../src/constants.js";
import type { ProjectConfig } from "../src/project.js";
import { collectCapabilityChecks } from "../src/verification-capabilities.js";
import type { Check } from "../src/verification-helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createProject(options: {
  capability: string;
  manifestPrefix?: string;
  middlewareBlock?: string;
  registration?: string;
  /** Extra `defineApp` members, e.g. an `agents: { mcp: { … } }` block. */
  appBlock?: string;
  /** Extra files written under `src/`, keyed by relative path. */
  extraFiles?: Record<string, string>;
}): ProjectConfig {
  const root = mkdtempSync(join(tmpdir(), "pracht-verify-capabilities-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src/capabilities"), { recursive: true });

  writeFileSync(join(root, "src/capabilities/notes-search.ts"), options.capability, "utf-8");
  for (const [path, contents] of Object.entries(options.extraFiles ?? {})) {
    const target = join(root, "src", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents, "utf-8");
  }
  writeFileSync(
    join(root, "src/routes.ts"),
    [
      'import { defineApp, route } from "@pracht/core";',
      options.manifestPrefix ?? "",
      "export const app = defineApp({",
      options.middlewareBlock ?? "",
      options.appBlock ?? "",
      "  capabilities: {",
      options.registration ?? '    "notes.search": () => import("./capabilities/notes-search.ts"),',
      "  },",
      '  routes: [route("/", () => import("./routes/home.tsx"))],',
      "});",
    ].join("\n"),
    "utf-8",
  );

  return {
    ...PROJECT_DEFAULTS,
    configFile: join(root, "vite.config.ts"),
    hasPrachtPlugin: true,
    mode: "manifest",
    rawConfig: "",
    root,
  } as ProjectConfig;
}

function runChecks(capability: string): Check[] {
  const checks: Check[] = [];
  collectCapabilityChecks(createProject({ capability }), checks);
  return checks;
}

function capabilitySource(fields: string): string {
  return [
    'import { defineCapability } from "@pracht/capabilities";',
    "",
    "export default defineCapability({",
    fields,
    "  async run() {",
    "    return {};",
    "  },",
    "});",
    "",
  ].join("\n");
}

const COMPLETE_FIELDS = `  title: "Search notes",
  description: "Find notes.",
  input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  output: { type: "object" },
  effect: "read",
  expose: { http: true, webmcp: true },`;

describe("collectCapabilityChecks", () => {
  it("passes a complete exposed capability", () => {
    const checks = runChecks(capabilitySource(COMPLETE_FIELDS));

    expect(checks.some((check) => check.status === "error")).toBe(false);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("declares a complete exposed contract (effect: read)"),
    );
  });

  it("warns when a capability name is also a namespace on the generated client", () => {
    // `capabilities.notes` cannot be both a callable and the object holding
    // `capabilities.notes.search`, so the shorter name loses. It still works
    // over HTTP and through callCapability(), hence a warning, not an error.
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(COMPLETE_FIELDS),
        registration: [
          '    "notes": () => import("./capabilities/notes-search.ts"),',
          '    "notes.search": () => import("./capabilities/notes-search.ts"),',
        ].join("\n"),
      }),
      checks,
    );

    expect(checks.some((check) => check.status === "error")).toBe(false);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('Capability "notes" is also a namespace for "notes.search"'),
    );
  });

  it("does not warn about namespaces for ordinary dotted names", () => {
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(COMPLETE_FIELDS),
        registration: [
          '    "notes.search": () => import("./capabilities/notes-search.ts"),',
          '    "notes.create": () => import("./capabilities/notes-search.ts"),',
        ].join("\n"),
      }),
      checks,
    );

    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("is also a namespace"),
    );
  });

  it("does not warn when a private longer name cannot shadow the generated client", () => {
    const project = createProject({
      capability: capabilitySource(COMPLETE_FIELDS),
      registration: [
        '    "notes": () => import("./capabilities/notes-search.ts"),',
        '    "notes.search": () => import("./capabilities/notes-private.ts"),',
      ].join("\n"),
    });
    writeFileSync(
      join(project.root, "src/capabilities/notes-private.ts"),
      capabilitySource(`  title: "Private search",
  description: "Search notes on the server only.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",`),
      "utf-8",
    );

    const checks: Check[] = [];
    collectCapabilityChecks(project, checks);

    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("is also a namespace"),
    );
  });

  it("warns instead of passing when expose is not an inline literal", () => {
    const source = [
      'import { defineCapability } from "@pracht/capabilities";',
      "",
      "const EXPOSE = { http: true };",
      "export default defineCapability({",
      '  title: "Purge notes",',
      '  description: "Delete notes.",',
      '  input: { type: "object" },',
      '  output: { type: "object" },',
      '  effect: "destructive",',
      "  expose: EXPOSE,",
      "  async run() {",
      "    return {};",
      "  },",
      "});",
      "",
    ].join("\n");
    const checks = runChecks(source);

    // The destructive-exposure / confirmation-secret checks can't run, so it
    // must warn rather than silently claim a complete contract.
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('the "expose" field is not an inline object literal'),
    );
    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("declares a complete"),
    );
  });

  it.each(["true", "null", "[]"])("rejects a non-object inline expose value (%s)", (expose) => {
    const checks = runChecks(
      capabilitySource(`  title: "Search notes",
  description: "Find notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  expose: ${expose},`),
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('"expose" must be an inline object literal'),
        status: "error",
      }),
    );
    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("declares a complete"),
    );
  });

  it("reports an empty exposure object as a private contract", () => {
    const checks = runChecks(
      capabilitySource(`  title: "Search notes",
  description: "Find notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  expose: {},`),
    );

    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("declares a complete private contract"),
    );
  });

  it("reads the live registry when a block-commented example precedes it", () => {
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(COMPLETE_FIELDS),
        middlewareBlock: [
          "  /*",
          "  capabilities: {",
          '    "notes.fake": () => import("./capabilities/notes-fake.ts"),',
          "  },",
          "  */",
        ].join("\n"),
      }),
      checks,
    );

    // The commented example must not shadow the live registry: the real
    // capability is analyzed (its OK check appears) and the fake one is not.
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("declares a complete exposed contract"),
    );
    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("notes.fake"),
    );
  });

  it("does not count a commented-out registration", () => {
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(
          `  title: "Purge",
  description: "Delete everything.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "destructive",
  expose: { http: true },`,
        ),
        registration: '    // "notes.search": () => import("./capabilities/notes-search.ts"),',
      }),
      checks,
    );

    // Nothing is registered, so the destructive-without-secret error must not
    // fire for the commented-out capability.
    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
  });

  it("fails exposed capabilities that are missing contract fields", () => {
    const checks = runChecks(
      capabilitySource(`  title: "Search notes",
  input: { type: "object" },
  expose: { http: true },`),
    );

    const errors = checks.filter((check) => check.status === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      "is missing required fields: description, output schema, effect",
    );
  });

  it("fails capabilities that are missing required fields even when private", () => {
    const checks = runChecks(
      capabilitySource(`  description: "Private op.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",`),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(expect.stringContaining("is missing required fields: title"));
  });

  it("fails capabilities with invalid effect values", () => {
    const checks = runChecks(
      capabilitySource(COMPLETE_FIELDS.replace('effect: "read"', 'effect: "publish"')),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(expect.stringContaining('"effect" must be "read", "write", or "destructive"'));
  });

  it("fails capabilities with invalid agent policy values", () => {
    const checks = runChecks(
      capabilitySource(`${COMPLETE_FIELDS}
  agentPolicy: "signed",`),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(expect.stringContaining('"agentPolicy" must be "observe" or "require"'));
  });

  it("warns instead of failing when agent policy is not statically analyzable", () => {
    const checks = runChecks(
      capabilitySource(`${COMPLETE_FIELDS}
  agentPolicy: sharedAgentPolicy,`),
    );

    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('"agentPolicy" field is not an inline string literal'),
    );
  });

  it("fails capabilities that reference unknown middleware", () => {
    const checks = runChecks(
      capabilitySource(`${COMPLETE_FIELDS}
  middleware: ["auth"],`),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(expect.stringContaining('references unknown middleware "auth"'));
  });

  it("warns instead of failing when middleware is not statically analyzable", () => {
    const checks = runChecks(
      capabilitySource(`${COMPLETE_FIELDS}
  middleware: sharedMiddleware,`),
    );

    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('"middleware" field is not an inline array literal'),
    );
  });

  it("accepts capabilities that reference registered middleware", () => {
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(`${COMPLETE_FIELDS}
  middleware: ["auth"],`),
        middlewareBlock: '  middleware: { auth: () => import("./middleware/auth.ts") },',
      }),
      checks,
    );

    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
  });

  it("fails malformed HTTP exposure config", () => {
    const checks = runChecks(
      capabilitySource(
        COMPLETE_FIELDS.replace(
          "expose: { http: true, webmcp: true },",
          'expose: { http: { method: "GET", path: "api/custom" } },',
        ),
      ),
    );

    const errors = checks.filter((check) => check.status === "error").map((check) => check.message);
    expect(errors).toContainEqual(
      expect.stringContaining('HTTP exposure only supports method: "POST"'),
    );
    expect(errors).toContainEqual(
      expect.stringContaining(
        'HTTP exposure "path" must be an exact same-origin pathname starting with "/"',
      ),
    );
  });

  it("fails destructive capabilities exposed as WebMCP page tools", () => {
    // COMPLETE_FIELDS exposes http + webmcp — destructive may not use webmcp.
    const checks = runChecks(
      capabilitySource(COMPLETE_FIELDS.replace('effect: "read"', 'effect: "destructive"')),
    );

    const errors = checks.filter((check) => check.status === "error");
    expect(errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining("is destructive and exposed as a WebMCP page tool"),
    );
  });

  it("fails MCP exposure with non-object schema roots", () => {
    const checks = runChecks(
      capabilitySource(`  title: "Search notes",
  description: "Find notes.",
  input: { type: "string" },
  output: { type: "array", items: { type: "string" } },
  effect: "read",
  expose: { mcp: true },`),
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          'expose.mcp requires "input" and "output" schemas with type: "object"',
        ),
        status: "error",
      }),
    );
  });

  it("fails MCP capability names that project beyond the host limit", () => {
    const name = "a".repeat(65);
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(`  title: "Search notes",
  description: "Find notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  expose: { mcp: true },`),
        registration: `    "${name}": () => import("./capabilities/notes-search.ts"),`,
      }),
      checks,
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("projected MCP tool names must match"),
        status: "error",
      }),
    );
  });

  it("fails destructive http exposure without the confirmation secret", () => {
    const previous = process.env.PRACHT_CONFIRMATION_SECRET;
    delete process.env.PRACHT_CONFIRMATION_SECRET;
    try {
      const checks = runChecks(
        capabilitySource(
          COMPLETE_FIELDS.replace('effect: "read"', 'effect: "destructive"').replace(
            "expose: { http: true, webmcp: true },",
            "expose: { http: true },",
          ),
        ),
      );

      const errors = checks.filter((check) => check.status === "error");
      expect(errors.map((error) => error.message)).toContainEqual(
        expect.stringContaining("without PRACHT_CONFIRMATION_SECRET"),
      );
    } finally {
      if (previous !== undefined) process.env.PRACHT_CONFIRMATION_SECRET = previous;
    }
  });

  it("fails destructive http exposure when expose keys are quoted", () => {
    const previous = process.env.PRACHT_CONFIRMATION_SECRET;
    delete process.env.PRACHT_CONFIRMATION_SECRET;
    try {
      const checks = runChecks(
        capabilitySource(
          COMPLETE_FIELDS.replace('effect: "read"', 'effect: "destructive"').replace(
            "expose: { http: true, webmcp: true },",
            'expose: { "http": true },',
          ),
        ),
      );

      expect(
        checks.filter((check) => check.status === "error").map((check) => check.message),
      ).toContainEqual(expect.stringContaining("without PRACHT_CONFIRMATION_SECRET"));
    } finally {
      if (previous !== undefined) process.env.PRACHT_CONFIRMATION_SECRET = previous;
    }
  });

  it("accepts destructive http exposure when the confirmation secret is configured", () => {
    const previous = process.env.PRACHT_CONFIRMATION_SECRET;
    process.env.PRACHT_CONFIRMATION_SECRET = "verify-test-secret";
    try {
      const checks = runChecks(
        capabilitySource(
          COMPLETE_FIELDS.replace('effect: "read"', 'effect: "destructive"').replace(
            "expose: { http: true, webmcp: true },",
            "expose: { http: true },",
          ),
        ),
      );

      expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.PRACHT_CONFIRMATION_SECRET;
      else process.env.PRACHT_CONFIRMATION_SECRET = previous;
    }
  });

  describe("destructive capabilities over MCP", () => {
    const DESTRUCTIVE_MCP = capabilitySource(
      COMPLETE_FIELDS.replace('effect: "read"', 'effect: "destructive"').replace(
        "expose: { http: true, webmcp: true },",
        "expose: { mcp: true },",
      ),
    );
    const STORE_MODULE = [
      'import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";',
      "setCapabilityApprovalStore(createSqlApprovalStore({ execute }));",
      "",
    ].join("\n");

    function checksFor(
      options: {
        appBlock?: string;
        extraFiles?: Record<string, string>;
      },
      project: Partial<ProjectConfig> = {},
    ) {
      const previous = process.env.PRACHT_CONFIRMATION_SECRET;
      process.env.PRACHT_CONFIRMATION_SECRET = "verify-test-secret";
      try {
        const checks: Check[] = [];
        collectCapabilityChecks(
          { ...createProject({ capability: DESTRUCTIVE_MCP, ...options }), ...project },
          checks,
        );
        return checks;
      } finally {
        if (previous === undefined) delete process.env.PRACHT_CONFIRMATION_SECRET;
        else process.env.PRACHT_CONFIRMATION_SECRET = previous;
      }
    }

    const errorsOf = (checks: Check[]): string[] =>
      checks.filter((check) => check.status === "error").map((check) => check.message);
    const warningsOf = (checks: Check[]): string[] =>
      checks.filter((check) => check.status === "warning").map((check) => check.message);

    it("warns when the app serves MCP without opting into destructive tools", () => {
      const checks = checksFor({ appBlock: "  agents: { mcp: {} }," });
      // A warning, not an error: the runtime is the gate that actually refuses
      // to serve.
      expect(errorsOf(checks)).toEqual([]);
      expect(warningsOf(checks)).toContainEqual(
        expect.stringContaining("does not set agents.mcp.destructive"),
      );
    });

    it("recognizes quoted destructive MCP configuration keys", () => {
      const checks = checksFor({
        appBlock: '  "agents": { "mcp": { "destructive": true } },',
        extraFiles: { "server/approvals.ts": STORE_MODULE },
      });

      expect(errorsOf(checks)).toEqual([]);
      expect(warningsOf(checks)).not.toContainEqual(
        expect.stringContaining("does not set agents.mcp.destructive"),
      );
      expect(checks.map((check) => check.message)).toContainEqual(
        expect.stringContaining("setCapabilityApprovalStore() call exists in the scanned source"),
      );
    });

    it("ignores destructive text outside agents.mcp", () => {
      const checks = checksFor({
        appBlock: [
          "  agents: { mcp: { destructive: false } },",
          "  // An unrelated example may still say destructive: true.",
        ].join("\n"),
      });

      expect(errorsOf(checks)).toEqual([]);
      expect(warningsOf(checks)).toContainEqual(
        expect.stringContaining("does not set agents.mcp.destructive"),
      );
      expect(warningsOf(checks)).not.toContainEqual(
        expect.stringContaining("setCapabilityApprovalStore("),
      );
    });

    it.each([
      ["does not configure MCP", ""],
      ["keeps destructive MCP disabled", "  agents: { mcp: { destructive: false } },"],
    ])("does not require a confirmation secret when the app %s", (_label, appBlock) => {
      const previous = process.env.PRACHT_CONFIRMATION_SECRET;
      delete process.env.PRACHT_CONFIRMATION_SECRET;
      try {
        const checks: Check[] = [];
        collectCapabilityChecks(createProject({ capability: DESTRUCTIVE_MCP, appBlock }), checks);

        expect(errorsOf(checks)).toEqual([]);
        expect(warningsOf(checks)).toContainEqual(expect.stringContaining("expose.mcp"));
      } finally {
        if (previous !== undefined) process.env.PRACHT_CONFIRMATION_SECRET = previous;
      }
    });

    it("warns, and never blocks, when no approval store registration is found", () => {
      const checks = checksFor({ appBlock: "  agents: { mcp: { destructive: true } }," });
      expect(errorsOf(checks)).toEqual([]);
      const warning = warningsOf(checks).find((message) =>
        message.includes("setCapabilityApprovalStore("),
      );
      // Naming where it looked is the difference between an actionable warning
      // and a mystery: the registration may legitimately live elsewhere.
      expect(warning).toContain("/src/server");
      expect(warning).toContain("/src/capabilities");
      expect(warning).toContain("workspace package");
    });

    it("ignores store registration text in comments and literals", () => {
      const checks = checksFor({
        appBlock: "  agents: { mcp: { destructive: true } },",
        extraFiles: {
          "server/approvals.ts": [
            "// setCapabilityApprovalStore(store);",
            "/* setCapabilityApprovalStore(store); */",
            'const example = "setCapabilityApprovalStore(store)";',
            "const template = `setCapabilityApprovalStore(store)`;",
            "const pattern = /setCapabilityApprovalStore\\(store\\)/;",
          ].join("\n"),
        },
      });

      expect(errorsOf(checks)).toEqual([]);
      expect(warningsOf(checks)).toContainEqual(
        expect.stringContaining("no `setCapabilityApprovalStore(` call was found"),
      );
      expect(checks.map((check) => check.message)).not.toContainEqual(
        expect.stringContaining("call exists in the scanned source"),
      );
    });

    it("recognizes a store registration call split across whitespace", () => {
      const checks = checksFor({
        appBlock: "  agents: { mcp: { destructive: true } },",
        extraFiles: {
          "server/approvals.ts": "setCapabilityApprovalStore\n  (approvalStore);",
        },
      });

      expect(errorsOf(checks)).toEqual([]);
      expect(checks.map((check) => check.message)).toContainEqual(
        expect.stringContaining("setCapabilityApprovalStore() call exists in the scanned source"),
      );
    });

    it("finds a store registered under a non-default serverDir", () => {
      const checks = checksFor(
        {
          appBlock: "  agents: { mcp: { destructive: true } },",
          extraFiles: { "runtime/approvals.ts": STORE_MODULE },
        },
        { serverDir: "/src/runtime" },
      );

      expect(errorsOf(checks)).toEqual([]);
      expect(checks.map((check) => check.message)).toContainEqual(
        expect.stringContaining("setCapabilityApprovalStore() call exists in the scanned source"),
      );
    });

    it("accepts the opt-in with a registered approval store", () => {
      const checks = checksFor({
        appBlock: "  agents: { mcp: { destructive: true } },",
        extraFiles: { "server/approvals.ts": STORE_MODULE },
      });

      expect(errorsOf(checks)).toEqual([]);
      expect(checks.map((check) => check.message)).toContainEqual(
        expect.stringContaining("setCapabilityApprovalStore() call exists in the scanned source"),
      );
    });

    it("fails destructive MCP exposure without the confirmation secret", () => {
      const previous = process.env.PRACHT_CONFIRMATION_SECRET;
      delete process.env.PRACHT_CONFIRMATION_SECRET;
      try {
        const checks: Check[] = [];
        collectCapabilityChecks(
          createProject({
            capability: DESTRUCTIVE_MCP,
            appBlock: "  agents: { mcp: { destructive: true } },",
            extraFiles: { "server/approvals.ts": STORE_MODULE },
          }),
          checks,
        );
        expect(errorsOf(checks)).toContainEqual(
          expect.stringContaining("without PRACHT_CONFIRMATION_SECRET"),
        );
      } finally {
        if (previous !== undefined) process.env.PRACHT_CONFIRMATION_SECRET = previous;
      }
    });

    it("only warns when the manifest's agents config cannot be read statically", () => {
      // No visible `agents.mcp`: the existing "nothing serves it" warning is the
      // honest answer, and a static scan must not fail a build it cannot judge.
      const checks = checksFor({});
      expect(errorsOf(checks)).toEqual([]);
      expect(
        checks.filter((check) => check.status === "warning").map((check) => check.message),
      ).toContainEqual(expect.stringContaining("does not configure agents.mcp"));
    });
  });

  it("fails webmcp exposure without http", () => {
    const checks = runChecks(
      capabilitySource(
        COMPLETE_FIELDS.replace(
          "expose: { http: true, webmcp: true },",
          "expose: { webmcp: true },",
        ),
      ),
    );

    const errors = checks.filter((check) => check.status === "error");
    expect(errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining("sets expose.webmcp without expose.http"),
    );
  });

  it("fails webmcp exposure without http when expose keys are quoted", () => {
    const checks = runChecks(
      capabilitySource(
        COMPLETE_FIELDS.replace(
          "expose: { http: true, webmcp: true },",
          'expose: { "webmcp": true },',
        ),
      ),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(expect.stringContaining("sets expose.webmcp without expose.http"));
  });

  it("fails schemas using unsupported JSON Schema keywords", () => {
    const checks = runChecks(
      capabilitySource(
        COMPLETE_FIELDS.replace(
          'input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },',
          'input: { type: "object", properties: { query: { type: "string", pattern: "^a" } } },',
        ),
      ),
    );

    const errors = checks.filter((check) => check.status === "error");
    expect(errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining("unsupported JSON Schema keywords: /properties/query/pattern"),
    );
  });

  it("fails schemas using malformed supported keyword values", () => {
    const checks = runChecks(
      capabilitySource(
        COMPLETE_FIELDS.replace(
          'input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },',
          'input: { type: "object", required: "query" },',
        ),
      ),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(
      expect.stringContaining(
        '"input" schema has invalid JSON Schema values: /required:<expected string array>',
      ),
    );
  });

  it("warns instead of failing when a schema is not statically analyzable", () => {
    const checks = runChecks(
      capabilitySource(
        COMPLETE_FIELDS.replace(
          'input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },',
          "input: sharedInputSchema,",
        ),
      ),
    );

    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("could not be verified statically"),
    );
  });

  it("does not execute expressions while statically verifying fields", () => {
    const marker = `__prachtVerifyExecuted_${Date.now()}`;
    try {
      const checks = runChecks(
        capabilitySource(
          COMPLETE_FIELDS.replace(
            'input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },',
            `input: (() => { globalThis.${marker} = true; return { type: "object" }; })(),`,
          ),
        ),
      );

      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
      expect(checks.map((check) => check.message)).toContainEqual(
        expect.stringContaining("could not be verified statically"),
      );
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
    }
  });

  it("warns instead of failing when string metadata is not statically analyzable", () => {
    const checks = runChecks(
      capabilitySource(`  title: sharedTitle,
  description: sharedDescription,
  input: { type: "object" },
  output: { type: "object" },
  effect: sharedEffect,`),
    );

    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('"title" field is not an inline string literal'),
    );
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('"description" field is not an inline string literal'),
    );
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('"effect" field is not an inline string literal'),
    );
  });

  it("fails HTTP exposure when effect is not statically analyzable", () => {
    const checks = runChecks(
      capabilitySource(`  title: "Search",
  description: "Find notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: sharedEffect,
  expose: { http: true },`),
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('"effect" must be an inline "read", "write"'),
        status: "error",
      }),
    );
  });

  it("rejects protocol-relative custom HTTP paths", () => {
    const checks = runChecks(
      capabilitySource(`  title: "Search",
  description: "Find notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  expose: { http: { path: "//evil.test/collect" } },`),
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("exact same-origin pathname"),
        status: "error",
      }),
    );
  });

  it("verifies the capability registry inside the exported app", () => {
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(`${COMPLETE_FIELDS}
  middleware: ["auth"],`),
        manifestPrefix:
          'const metadata = { capabilities: { "wrong.tool": () => import("./missing.ts") }, middleware: { wrong: "./wrong.ts" } };',
        middlewareBlock: '  middleware: { auth: "./middleware/auth.ts" },',
      }),
      checks,
    );

    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining('Capability "notes.search"'),
    );
    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("wrong.tool"),
    );
    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining('unknown middleware "auth"'),
    );
  });

  it("does nothing for apps without a capabilities registry", () => {
    const checks: Check[] = [];
    const project = createProject({ capability: "export default {};", registration: "" });
    collectCapabilityChecks(project, checks);
    expect(checks).toEqual([]);
  });

  it("verifies capabilities registered with a root-relative path", () => {
    // The runtime registry and the Vite plugin both resolve "/src/..." against
    // the project root, so verification has to as well — otherwise the whole
    // contract, including the destructive-exposure check, is silently skipped.
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: capabilitySource(`  title: "Purge notes",
  description: "Delete notes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "destructive",
  expose: { http: true, webmcp: true },`),
        registration: '    "notes.search": () => import("/src/capabilities/notes-search.ts"),',
      }),
      checks,
    );

    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("exposed as a WebMCP page tool"),
    );
  });

  it("reports a missing root-relative capability file", () => {
    // The manifest check only reports missing "./"-relative references.
    const checks: Check[] = [];
    collectCapabilityChecks(
      createProject({
        capability: "export default {};",
        registration: '    "notes.search": () => import("/src/capabilities/nope.ts"),',
      }),
      checks,
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('references missing file "/src/capabilities/nope.ts"'),
        status: "error",
      }),
    );
  });

  it("allows private capabilities without exposure metadata", () => {
    const checks = runChecks(
      capabilitySource(`  title: "Private op",
  description: "Server-only.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "destructive",`),
    );

    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("declares a complete private contract (effect: destructive)"),
    );
  });
});

/**
 * `agents.mcp.auth` is the OAuth resource-server config. These checks are
 * static, so the rule is: never hard-error on a manifest that works at runtime,
 * and never green-light one that cannot.
 */
describe("collectCapabilityChecks: agents.mcp.auth", () => {
  function runAuthChecks(agentsBlock: string, verifyFile = "src/server/mcp-token.ts"): Check[] {
    const project = createProject({
      capability: capabilitySource(COMPLETE_FIELDS),
      middlewareBlock: agentsBlock,
    });
    if (verifyFile) {
      mkdirSync(join(project.root, verifyFile.replace(/\/[^/]*$/, "")), { recursive: true });
      writeFileSync(join(project.root, verifyFile), "export default () => null;\n", "utf-8");
    }
    const checks: Check[] = [];
    collectCapabilityChecks(project, checks);
    return checks;
  }

  const authBlock = (extra = "", verifyPath = "./server/mcp-token.ts") => `  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
${extra}        verify: () => import("${verifyPath}"),
      },
    },
  },`;

  it("passes a complete auth config", () => {
    const checks = runAuthChecks(authBlock());
    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    expect(checks.map((check) => check.message)).toContainEqual(
      expect.stringContaining("OAuth 2.0 protected resource"),
    );
  });

  it("rejects the reserved protected-resource metadata path", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      path: "/.well-known/oauth-protected-resource",
      auth: {
        resource: "https://app.example.com/.well-known/oauth-protected-resource",
        authorizationServers: ["https://auth.example.com"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`);
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("reserved OAuth protected-resource metadata path"),
        status: "error",
      }),
    );
  });

  it("errors on a relative resource identifier", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        resource: "/mcp",
        authorizationServers: ["https://auth.example.com"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`);
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("is not an absolute URL"),
        status: "error",
      }),
    );
  });

  it("errors on a resource identifier with a trailing slash", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp/",
        authorizationServers: ["https://auth.example.com"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`);
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("must not carry a trailing slash"),
        status: "error",
      }),
    );
  });

  it("errors on resource-server fields that runtime validation rejects", () => {
    for (const [agentsBlock, message] of [
      [
        `  agents: {
    mcp: {
      auth: {
        authorizationServers: ["https://auth.example.com"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`,
        "without a `resource` URL",
      ],
      [authBlock('        resource: "http://public.example/mcp",\n'), "must use https"],
      [
        `  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: [],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`,
        "must list at least one",
      ],
      [
        `  agents: {
    mcp: {
      path: "/agent/mcp",
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`,
        "does not address the configured MCP endpoint",
      ],
      [
        `  agents: {
    mcp: {
      path: "agent/mcp",
      auth: {
        resource: "https://app.example.com/agent/mcp",
        authorizationServers: ["https://auth.example.com"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`,
        "must be an exact same-origin pathname",
      ],
      [authBlock('        requiredScopes: ["notes read"],\n'), "scope tokens"],
      [authBlock('        requiredScopes: ["notes\\u0000read"],\n'), "scope tokens"],
      [authBlock('        requiredScopes: ["café"],\n'), "scope tokens"],
      [
        authBlock('        resourceDocumentation: "http://docs.example/mcp",\n'),
        "resourceDocumentation",
      ],
    ] as const) {
      const checks = runAuthChecks(agentsBlock);
      expect(checks).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining(message), status: "error" }),
      );
      expect(checks.map((check) => check.message)).not.toContainEqual(
        expect.stringContaining("OAuth 2.0 protected resource"),
      );
    }
  });

  it("allows cleartext resource and issuer URLs only on loopback", () => {
    const accepted = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        resource: "http://127.0.0.1:3000/mcp",
        authorizationServers: ["http://localhost:8787"],
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },`);
    expect(accepted.filter((check) => check.status === "error")).toHaveLength(0);

    const rejected = runAuthChecks(
      authBlock('        authorizationServers: ["http://auth.example"],\n'),
    );
    expect(rejected).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("must use https"),
        status: "error",
      }),
    );
  });

  it("errors when auth is configured without a verify module", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
      },
    },
  },`);
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("without a `verify` module"),
        status: "error",
      }),
    );
  });

  it("rejects an inline verifier instead of silently accepting it", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        verify: async () => ({ subject: "demo" }),
      },
    },
  },`);
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("must be a module reference"),
        status: "error",
      }),
    );
  });

  it("does not mistake commented or nested verifier references for the auth hook", () => {
    for (const verifyText of [
      '// verify: () => import("./server/mcp-token.ts")',
      'options: { verify: () => import("./server/mcp-token.ts") },',
    ]) {
      const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        ${verifyText}
      },
    },
  },`);
      expect(checks).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("without a `verify` module"),
          status: "error",
        }),
      );
      expect(checks.map((check) => check.message)).not.toContainEqual(
        expect.stringContaining("OAuth 2.0 protected resource"),
      );
    }
  });

  // A spread can carry `verify` in from a shared constant. Verification cannot
  // follow it, and a hard error on a config that works at runtime is worse than
  // no check at all.
  it("stays silent when the auth literal spreads a value it cannot read", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        ...sharedAuth,
        requiredScopes: ["notes.read"],
      },
    },
  },`);
    expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
  });

  it("still checks a verify path that survives a spread", () => {
    const checks = runAuthChecks(`  agents: {
    mcp: {
      auth: {
        ...sharedAuth,
        verify: () => import("./server/nope.ts"),
      },
    },
  },`);
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('references missing file "./server/nope.ts"'),
        status: "error",
      }),
    );
  });

  // The runtime resolves the verifier from registries globbed from three
  // directories. A file that exists elsewhere is never registered, so every
  // /mcp request would answer 401 with a config that looks correct.
  it("errors when the verify module sits outside the registered directories", () => {
    const checks = runAuthChecks(authBlock("", "./lib/mcp-token.ts"), "src/lib/mcp-token.ts");
    expect(checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("outside the directories the build registers"),
        status: "error",
      }),
    );
  });

  it("accepts a verify module in the middleware or capabilities directories", () => {
    for (const [ref, file] of [
      ["./middleware/mcp-token.ts", "src/middleware/mcp-token.ts"],
      ["./capabilities/mcp-token.ts", "src/capabilities/mcp-token.ts"],
    ] as const) {
      const checks = runAuthChecks(authBlock("", ref), file);
      expect(checks.filter((check) => check.status === "error")).toHaveLength(0);
    }
  });

  // Reads as protected, is read by nothing — the endpoint stays wide open.
  it("errors on auth placed directly under agents, even alongside an mcp block", () => {
    for (const agentsBlock of [
      `  agents: {
    auth: { resource: "https://app.example.com/mcp" },
  },`,
      `  agents: {
    mcp: { path: "/mcp" },
    auth: { resource: "https://app.example.com/mcp" },
  },`,
    ]) {
      const checks = runAuthChecks(agentsBlock, "");
      expect(checks).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("defineApp({ agents.auth }) is not a thing"),
          status: "error",
        }),
      );
    }
  });

  it("says nothing about auth when the app configures none", () => {
    const checks = runAuthChecks("  agents: { mcp: {} },", "");
    expect(checks.map((check) => check.message)).not.toContainEqual(
      expect.stringContaining("agents.mcp.auth"),
    );
  });
});
