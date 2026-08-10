import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hasAgentSurface } from "../src/plugin-capabilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createManifest(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-agent-surface-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src/routes"), { recursive: true });
  writeFileSync(join(root, "src/routes.ts"), body, "utf-8");
  writeFileSync(
    join(root, "src/routes/home.tsx"),
    "export function Component() { return null; }\n",
  );
  return root;
}

const PLAIN_MANIFEST = `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/", () => import("./routes/home.tsx"), { id: "home" })],
});
`;

describe("hasAgentSurface", () => {
  it("is false for a manifest with no capabilities and no agents config", () => {
    expect(hasAgentSurface({}, createManifest(PLAIN_MANIFEST))).toBe(false);
  });

  it("is false for pages-router apps, which have no manifest to register either in", () => {
    expect(hasAgentSurface({ pagesDir: "src/pages" }, createManifest(PLAIN_MANIFEST))).toBe(false);
  });

  it("is true when capabilities are registered", () => {
    const root = createManifest(`import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
  },
  routes: [route("/", () => import("./routes/home.tsx"), { id: "home" })],
});
`);
    expect(hasAgentSurface({}, root)).toBe(true);
  });

  it("is true when an agents config is present", () => {
    const root = createManifest(`import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  agents: { webBotAuth: { policy: "observe", keys: [] } },
  routes: [route("/", () => import("./routes/home.tsx"), { id: "home" })],
});
`);
    expect(hasAgentSurface({}, root)).toBe(true);
  });

  it.each([
    String.raw`"ag\u0065nts"`,
    String.raw`"capabil\u0069ties"`,
    String.raw`\u0061gents`,
    String.raw`\u0063apabilities`,
  ])("stays true for escaped agent-surface key %s", (key) => {
    const root = createManifest(`import { defineApp } from "@pracht/core";

export const app = defineApp({ ${key}: {}, routes: [] });
`);
    expect(hasAgentSurface({}, root)).toBe(true);
  });

  it.each([
    {
      name: "an agents shorthand property",
      source: `import { defineApp } from "@pracht/core";
import { agents } from "./agent-config.ts";

export const app = defineApp({ agents, routes: [] });
`,
    },
    {
      name: "a quoted agents property",
      source: `import { defineApp } from "@pracht/core";

export const app = defineApp({ "agents": { webBotAuth: { policy: "observe" } }, routes: [] });
`,
    },
    {
      name: "a capabilities shorthand property",
      source: `import { defineApp } from "@pracht/core";
import { capabilities } from "./capabilities.ts";

export const app = defineApp({ capabilities, routes: [] });
`,
    },
    {
      name: "an opaque app config",
      source: `import { defineApp } from "@pracht/core";
import { config } from "./app-config.ts";

export const app = defineApp(config);
`,
    },
    {
      name: "a computed top-level property",
      source: `import { defineApp } from "@pracht/core";
import { agentConfig, key } from "./agent-config.ts";

export const app = defineApp({ [key]: agentConfig, routes: [] });
`,
    },
  ])("stays true for $name that static analysis cannot disprove", ({ source }) => {
    expect(hasAgentSurface({}, createManifest(source))).toBe(true);
  });

  it("still proves a manifest with shorthand routes has no agent surface", () => {
    const root = createManifest(`import { defineApp } from "@pracht/core";
import { routes } from "./route-list.ts";

export const app = defineApp({ routes });
`);
    expect(hasAgentSurface({}, root)).toBe(false);
  });

  it("stays true when the manifest spreads config the analyzer cannot see", () => {
    const root = createManifest(`import { defineApp, route } from "@pracht/core";
import { shared } from "./shared.ts";

export const app = defineApp({
  ...shared,
  routes: [route("/", () => import("./routes/home.tsx"), { id: "home" })],
});
`);
    expect(hasAgentSurface({}, root)).toBe(true);
  });

  it("stays true when the manifest cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-agent-surface-empty-"));
    tempDirs.push(root);
    expect(hasAgentSurface({}, root)).toBe(true);
  });
});
