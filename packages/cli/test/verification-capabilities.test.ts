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
  middlewareBlock?: string;
  registration?: string;
}): ProjectConfig {
  const root = mkdtempSync(join(tmpdir(), "pracht-verify-capabilities-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src/capabilities"), { recursive: true });

  writeFileSync(join(root, "src/capabilities/notes-search.ts"), options.capability, "utf-8");
  writeFileSync(
    join(root, "src/routes.ts"),
    [
      'import { defineApp, route } from "@pracht/core";',
      "export const app = defineApp({",
      options.middlewareBlock ?? "",
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

  it("fails capabilities that reference unknown middleware", () => {
    const checks = runChecks(
      capabilitySource(`${COMPLETE_FIELDS}
  middleware: ["auth"],`),
    );

    expect(
      checks.filter((check) => check.status === "error").map((check) => check.message),
    ).toContainEqual(expect.stringContaining('references unknown middleware "auth"'));
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
      expect.stringContaining('HTTP exposure "path" must be a string starting with "/"'),
    );
  });

  it("fails destructive capabilities exposed to agent projections", () => {
    // COMPLETE_FIELDS exposes http + webmcp — destructive may only use http.
    const checks = runChecks(
      capabilitySource(COMPLETE_FIELDS.replace('effect: "read"', 'effect: "destructive"')),
    );

    const errors = checks.filter((check) => check.status === "error");
    expect(errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining("is destructive and exposed to agent projections"),
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

  it("does nothing for apps without a capabilities registry", () => {
    const checks: Check[] = [];
    const project = createProject({ capability: "export default {};", registration: "" });
    collectCapabilityChecks(project, checks);
    expect(checks).toEqual([]);
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
