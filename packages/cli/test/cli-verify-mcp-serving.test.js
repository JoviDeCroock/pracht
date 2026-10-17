import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCliStatus,
  writeManifestApp,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

function writeMcpCapability(appDir, expose) {
  writeProjectFile(
    appDir,
    "src/capabilities/search.ts",
    `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Search notes",
  description: "Find notes whose title matches the query.",
  effect: "read",
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
