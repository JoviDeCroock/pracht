import { describe, expect, it } from "vitest";

import { stripServerOnlyAppKeys } from "../src/analysis.ts";

const ID = "/app/src/routes.ts";

describe("stripServerOnlyAppKeys", () => {
  it("drops agents and constraints from the defineApp literal", () => {
    const code = [
      `import { defineApp, route } from "@pracht/core";`,
      `import { botKeys } from "./server/bot-keys.ts";`,
      `export const app = defineApp({`,
      `  shells: { app: "./shells/app.tsx" },`,
      `  capabilities: { "docs.read": "./capabilities/read.ts" },`,
      `  agents: { mcp: { serverInfo: { name: "docs", version: "1.0.0" } }, webBotAuth: botKeys },`,
      `  constraints: { requireMiddleware: ["auth"] } satisfies Constraints,`,
      `  routes: [route("/", "./routes/home.tsx")],`,
      `});`,
    ].join("\n");

    const stripped = stripServerOnlyAppKeys(code, ID);

    expect(stripped).not.toMatch(/agents|constraints|serverInfo|requireMiddleware/);
    expect(stripped).toContain(`  capabilities: { "docs.read": "./capabilities/read.ts" },\n`);
    expect(stripped).toContain(`  routes: [route("/", "./routes/home.tsx")],\n});`);
  });

  it("drops a trailing key with its comma, a quoted key, and a shorthand key", () => {
    const code = [
      `import { defineApp } from "@pracht/core/manifest";`,
      `import { agents } from "./agents.ts";`,
      `export default defineApp({ routes: [], agents, "constraints": {}, });`,
    ].join("\n");

    expect(stripServerOnlyAppKeys(code, ID)).toBe(
      [
        `import { defineApp } from "@pracht/core/manifest";`,
        `import { agents } from "./agents.ts";`,
        `export default defineApp({ routes: [],  });`,
      ].join("\n"),
    );
  });

  it("finds an app exported through a local binding", () => {
    const code = [
      `import { defineApp } from "@pracht/core";`,
      `const manifest = defineApp({ routes: [], agents: { mcp: {} } });`,
      `export { manifest as app };`,
    ].join("\n");

    expect(stripServerOnlyAppKeys(code, ID)).toContain(`defineApp({ routes: [],  })`);
  });

  it("leaves other objects and computed or spread keys alone", () => {
    const code = [
      `import { defineApp } from "@pracht/core";`,
      `const unrelated = { agents: 1 };`,
      `export const app = defineApp({ ...shared, ["agents"]: x, routes: [] });`,
    ].join("\n");

    expect(stripServerOnlyAppKeys(code, ID)).toBe(code);
  });

  it("returns unparseable source unchanged", () => {
    const code = `export const app = defineApp({ agents: { ) });`;
    expect(stripServerOnlyAppKeys(code, ID)).toBe(code);
  });
});
