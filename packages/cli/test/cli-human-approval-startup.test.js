import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCliStatus,
  writeManifestApp,
  vitePluginImportPath,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

function writeHumanApprovalApp(appDir, capabilityPrelude = "") {
  writeManifestApp(appDir, {
    routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  agents: { confirmation: { mode: "human" } },
  capabilities: { "notes.purge": "./capabilities/purge.ts" },
  routes: [route("/", "./routes/home.tsx", { render: "ssr" })],
});
`,
  });
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify({
      name: "fixture-app",
      private: true,
      type: "module",
      dependencies: { "@pracht/adapter-node": "workspace:*", "@pracht/cli": "workspace:*" },
    }),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from ${JSON.stringify(vitePluginImportPath)};

export default defineConfig({ plugins: [pracht()] });
`,
  );
  writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");
  writeProjectFile(
    appDir,
    "src/capabilities/purge.ts",
    `${capabilityPrelude}import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Purge notes",
  description: "Delete every note.",
  effect: "destructive",
  expose: { http: true },
  input: { type: "object", properties: {} },
  output: { type: "object", properties: {} },
  run: () => ({}),
});
`,
  );
}

describe("human approval without an end-user identity", () => {
  it("fails the build", () => {
    const appDir = createRepoTempDir("pracht-cli-human-approval-");
    writeHumanApprovalApp(appDir);

    const result = runCliStatus(["build"], { cwd: appDir });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("nothing identifies the end user");
  });

  it("builds when a capability module registers the principal resolver", () => {
    const appDir = createRepoTempDir("pracht-cli-human-approval-resolver-");
    writeHumanApprovalApp(
      appDir,
      `import { setCapabilityApprovalPrincipalResolver } from "@pracht/core/server";

setCapabilityApprovalPrincipalResolver(() => "user-1");
`,
    );

    const result = runCliStatus(["build"], { cwd: appDir });
    expect(`${result.stdout}${result.stderr}`).not.toContain("nothing identifies the end user");
    expect(result.status).toBe(0);
  });
});
