import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCliStatus,
  writeManifestApp,
  writePagesApp,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

function writeMcpCapability(appDir, expose, effect = "read") {
  writeProjectFile(
    appDir,
    "src/capabilities/search.ts",
    `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Search notes",
  description: "Find notes whose title matches the query.",
  effect: "${effect}",
  expose: ${expose},
  input: { type: "object", properties: { query: { type: "string" } } },
  output: { type: "object", properties: { hits: { type: "number" } } },
  run: () => ({ hits: 0 }),
});
`,
  );
  writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");
}

function servingWarnings(report) {
  return report.checks.filter(
    (check) =>
      check.status === "warning" &&
      (check.message.includes("nothing serves") || check.message.includes("expose.mcp scopes")),
  );
}

describe("pracht verify MCP serving", () => {
  it("reads agents.mcp from the resolved app, not the manifest text", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-mcp-shared-agents-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

const sharedAgents = { mcp: {} };

export const app = defineApp({
  agents: sharedAgents,
  capabilities: { "notes.search": "./capabilities/search.ts" },
  routes: [route("/", "./routes/home.tsx", { render: "ssr" })],
});
`,
    });
    writeMcpCapability(appDir, "{ mcp: true }");

    const report = JSON.parse(runCliStatus(["verify", "--json"], { cwd: appDir }).stdout);
    expect(servingWarnings(report)).toEqual([]);
  });

  it("checks the secret and approval store for destructive tools enabled through shared config", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-mcp-shared-destructive-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

const sharedAgents = { mcp: { destructive: true } };

export const app = defineApp({
  agents: sharedAgents,
  capabilities: { "notes.search": "./capabilities/search.ts" },
  routes: [route("/", "./routes/home.tsx", { render: "ssr" })],
});
`,
    });
    writeMcpCapability(appDir, "{ mcp: true }", "destructive");

    const env = { ...process.env };
    delete env.PRACHT_CONFIRMATION_SECRET;
    const report = JSON.parse(runCliStatus(["verify", "--json"], { cwd: appDir, env }).stdout);
    const warnings = report.checks
      .filter((check) => check.status === "warning")
      .map((check) => check.message);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("PRACHT_CONFIRMATION_SECRET is not set"),
        expect.stringContaining("no `setCapabilityApprovalStore(` call was found"),
      ]),
    );
  });

  it("resolves serving for auto-discovered capabilities in a pages app", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-mcp-pages-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(
      appDir,
      "src/pages/_app.config.ts",
      "const shared = { mcp: {} };\nexport const agents = shared;\n",
    );
    writeMcpCapability(appDir, "{ mcp: true }");

    const report = JSON.parse(runCliStatus(["verify", "--json"], { cwd: appDir }).stdout);
    expect(servingWarnings(report)).toEqual([]);
  });

  it("warns that a scoped tool is never served without agents.mcp.auth", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-mcp-scoped-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  agents: { mcp: {} },
  capabilities: { "notes.search": "./capabilities/search.ts" },
  routes: [route("/", "./routes/home.tsx", { render: "ssr" })],
});
`,
    });
    writeMcpCapability(appDir, '{ mcp: { scopes: ["notes.read"] } }');

    const report = JSON.parse(runCliStatus(["verify", "--json"], { cwd: appDir }).stdout);
    expect(servingWarnings(report)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('"notes.search" set expose.mcp scopes'),
      }),
    ]);
  });
});
