import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createPrachtMcpServer } from "../src/mcp-server.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const repoTempRoot = resolve(testDir, ".tmp");
const coreImportPath = resolve(repoRoot, "packages/framework/src/index.ts");
const nodeAdapterImportPath = resolve(repoRoot, "packages/adapter-node/src/index.ts");
const vitePluginImportPath = resolve(repoRoot, "packages/vite-plugin/src/index.ts");

const tempDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("pracht MCP server", () => {
  it("exposes the pracht tool set", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "doctor",
      "generate_api",
      "generate_middleware",
      "generate_route",
      "generate_shell",
      "get_docs",
      "inspect_api",
      "inspect_build",
      "inspect_capabilities",
      "inspect_routes",
      "plan",
      "report",
      "verify",
    ]);
  });

  it("runs doctor against a fixture app", async () => {
    const appDir = createTempDir("pracht-mcp-doctor-");
    writeManifestApp(appDir);

    const client = await connectClient();
    const report = await callToolJson(client, "doctor", { cwd: appDir });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("manifest");
    expect(Array.isArray(report.checks)).toBe(true);
  });

  it("runs verify against a fixture app", async () => {
    const appDir = createTempDir("pracht-mcp-verify-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" })],
});
`,
    });
    writeProjectFile(
      appDir,
      "src/routes/dashboard.tsx",
      `export function Component() {
  return <h1>Dashboard</h1>;
}
`,
    );

    const client = await connectClient();
    const report = await callToolJson(client, "verify", { cwd: appDir });

    expect(report.ok).toBe(true);
    expect(report.scope).toBe("full");
    expect(report.requestedScope).toBe("full");
  });

  it("scaffolds shells, middleware, routes, and api handlers", async () => {
    const appDir = createTempDir("pracht-mcp-generate-");
    writeManifestApp(appDir);

    const client = await connectClient();

    const shell = await callToolJson(client, "generate_shell", { cwd: appDir, name: "app" });
    expect(shell).toEqual({
      created: ["src/shells/app.tsx"],
      kind: "shell",
      updated: ["src/routes.ts"],
    });

    const middleware = await callToolJson(client, "generate_middleware", {
      cwd: appDir,
      name: "auth",
    });
    expect(middleware).toEqual({
      created: ["src/middleware/auth.ts"],
      kind: "middleware",
      updated: ["src/routes.ts"],
    });

    const route = await callToolJson(client, "generate_route", {
      cwd: appDir,
      loader: true,
      middleware: ["auth"],
      path: "/pricing",
      render: "isg",
      revalidate: 120,
      shell: "app",
    });
    expect(route).toEqual({
      created: ["src/routes/pricing.tsx"],
      kind: "route",
      updated: ["src/routes.ts"],
    });

    const api = await callToolJson(client, "generate_api", {
      cwd: appDir,
      methods: ["GET", "POST"],
      path: "/health",
    });
    expect(api).toEqual({
      created: ["src/api/health.ts"],
      kind: "api",
      updated: [],
    });

    const manifest = readFileSync(join(appDir, "src/routes.ts"), "utf-8");
    expect(manifest).toContain('shell: "app"');
    expect(manifest).toContain('middleware: ["auth"]');
    expect(manifest).toContain("revalidate: timeRevalidate(120)");
    expect(existsSync(join(appDir, "src/routes/pricing.tsx"))).toBe(true);
    expect(existsSync(join(appDir, "src/api/health.ts"))).toBe(true);
  });

  it("returns isError results instead of crashing on tool failures", async () => {
    const appDir = createTempDir("pracht-mcp-error-");
    writePagesApp(appDir);

    const client = await connectClient();
    const result = await client.callTool({
      name: "generate_shell",
      arguments: { cwd: appDir, name: "app" },
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("only available for manifest apps");

    // The server survives a failing tool call.
    const doctor = await callToolJson(client, "doctor", { cwd: appDir });
    expect(doctor.mode).toBe("pages");
  });

  it("inspects resolved routes through the MCP tool", async () => {
    const appDir = createRepoTempDir("pracht-mcp-inspect-");
    writeInspectableManifestApp(appDir);

    const client = await connectClient();
    const report = await callToolJson(client, "inspect_routes", { cwd: appDir });

    expect(report).toEqual({
      mode: "manifest",
      routes: [
        {
          file: "./routes/dashboard.tsx",
          hydration: null,
          id: "dashboard",
          loaderCache: null,
          loaderFile: null,
          middleware: [],
          path: "/dashboard",
          prefetch: null,
          render: "ssr",
          revalidate: null,
          shell: null,
          shellFile: null,
          speculation: null,
        },
      ],
    });
  }, 30_000);
});

async function connectClient(): Promise<Client> {
  const server = createPrachtMcpServer();
  const client = new Client({ name: "pracht-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });

  return client;
}

async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`Tool ${name} failed: ${textContent(result)}`);
  }
  return JSON.parse(textContent(result));
}

function textContent(result: unknown): string {
  const content = (result as { content?: { text?: string; type: string }[] }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  expect(typeof text).toBe("string");
  return text as string;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createRepoTempDir(prefix: string): string {
  mkdirSync(repoTempRoot, { recursive: true });
  const dir = mkdtempSync(join(repoTempRoot, prefix));
  tempDirs.push(dir);
  return dir;
}

function writeManifestApp(appDir: string, { routesSource }: { routesSource?: string } = {}): void {
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-mcp-app",
        private: true,
        dependencies: {
          "@pracht/adapter-node": "workspace:*",
          "@pracht/cli": "workspace:*",
        },
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht()],
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes.ts",
    routesSource ??
      `import { defineApp } from "@pracht/core";

export const app = defineApp({
  routes: [],
});
`,
  );
}

function writePagesApp(appDir: string): void {
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-mcp-pages-app",
        private: true,
        dependencies: {
          "@pracht/adapter-node": "workspace:*",
          "@pracht/cli": "workspace:*",
        },
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
`,
  );
}

function writeInspectableManifestApp(appDir: string): void {
  const vitePluginImport = pathToFileURL(vitePluginImportPath).href;

  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-mcp-inspect-app",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from ${JSON.stringify(vitePluginImport)};

export default defineConfig({
  plugins: [pracht()],
  resolve: {
    alias: {
      "@pracht/adapter-node": ${JSON.stringify(nodeAdapterImportPath)},
      "@pracht/core": ${JSON.stringify(coreImportPath)},
    },
  },
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes.ts",
    `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [
    route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" }),
  ],
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes/dashboard.tsx",
    `export function Component() {
  return <h1>Dashboard</h1>;
}
`,
  );
}

function writeProjectFile(appDir: string, relativePath: string, contents: string): void {
  const filePath = resolve(appDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf-8");
}
