import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";

import { collectAppGraph, loadAppMetadataModule } from "../src/app-graph.ts";

function fakeServer(
  modules: Record<string, unknown>,
  resolveId: (specifier: string, importer?: string) => Promise<unknown> = async () => null,
): ViteDevServer {
  return {
    pluginContainer: { resolveId: vi.fn(resolveId) },
    ssrLoadModule: vi.fn(async (id: string) => {
      if (!(id in modules)) {
        const error = new Error(
          `Failed to load url ${id} (resolved id: ${id}). Does the file exist?`,
        );
        Object.assign(error, { code: "ERR_LOAD_URL" });
        throw error;
      }
      if (modules[id] instanceof Error) throw modules[id];
      return modules[id] as Record<string, unknown>;
    }),
  } as unknown as ViteDevServer;
}

describe("loadAppMetadataModule", () => {
  // The Cloudflare adapter re-exports Durable Objects (which import
  // `cloudflare:workers`) from the server entry — unresolvable in Vite's Node
  // SSR environment, so graph-reading commands must not touch that entry.
  it("reads the adapter-neutral dev metadata module", async () => {
    const server = fakeServer({
      "virtual:pracht/dev-metadata": { buildTarget: "cloudflare" },
      "virtual:pracht/server": { buildTarget: "should-not-be-read" },
    });

    await expect(loadAppMetadataModule(server)).resolves.toMatchObject({
      buildTarget: "cloudflare",
    });
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(1);
  });

  it("falls back to the server entry for older vite-plugin versions", async () => {
    const server = fakeServer({ "virtual:pracht/server": { buildTarget: "node" } });

    await expect(loadAppMetadataModule(server)).resolves.toMatchObject({
      buildTarget: "node",
    });
  });

  it("does not mask an app error from the metadata module", async () => {
    const server = fakeServer({
      "virtual:pracht/dev-metadata": new Error('Unknown middleware "atu" for route "/".'),
      "virtual:pracht/server": new Error("Cannot find module 'cloudflare:workers'"),
    });

    await expect(loadAppMetadataModule(server)).rejects.toThrow(
      'Unknown middleware "atu" for route "/".',
    );
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(1);
  });

  it("surfaces the app's own load error when neither module loads", async () => {
    await expect(loadAppMetadataModule(fakeServer({}))).rejects.toThrow(
      "Failed to load url virtual:pracht/server",
    );
  });
});

describe("collectAppGraph", () => {
  it("does not report skipped server-entry registrations as a proven outage", async () => {
    const destructiveMcpPreconditionErrors = vi.fn(() => ["no approval store is registered."]);
    const capability = {
      kind: "capability",
      title: "Purge notes",
      description: "Purge every note.",
      input: { type: "object" },
      output: { type: "object" },
      effect: "destructive",
      expose: { mcp: true },
      run: async () => ({}),
    };
    const server = fakeServer({
      "@pracht/core/server": { destructiveMcpPreconditionErrors },
      "virtual:pracht/server": { registrationWouldRunHere: true },
      "virtual:pracht/dev-metadata": {
        apiRoutes: [],
        registry: {
          capabilityModules: {
            "/src/capabilities/notes-purge.ts": async () => ({ default: capability }),
          },
        },
        resolvedApp: {
          agents: { mcp: { destructive: true } },
          capabilities: { "notes.purge": "./capabilities/notes-purge.ts" },
          routes: [],
        },
      },
    });

    const graph = await collectAppGraph(server, process.cwd());

    expect(graph.mcpUnavailableReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("no approval store is registered")]),
    );
    expect(graph.mcpRuntimeStatus).toBe("unverified");
    expect(server.ssrLoadModule).not.toHaveBeenCalledWith("virtual:pracht/server");
    expect(destructiveMcpPreconditionErrors).toHaveBeenCalledWith({
      mcp: { destructive: true },
    });
  });

  it("reads destructive MCP preconditions from the Vite SSR runtime instance", async () => {
    const destructiveMcpPreconditionErrors = vi.fn(() => []);
    const capability = {
      kind: "capability",
      title: "Purge notes",
      description: "Purge every note.",
      input: { type: "object" },
      output: { type: "object" },
      effect: "destructive",
      expose: { mcp: true },
      run: async () => ({}),
    };
    const server = fakeServer({
      "@pracht/core/server": { destructiveMcpPreconditionErrors },
      "virtual:pracht/dev-metadata": {
        apiRoutes: [],
        registry: {
          capabilityModules: {
            "/src/capabilities/notes-purge.ts": async () => ({ default: capability }),
          },
        },
        resolvedApp: {
          agents: { mcp: { destructive: true } },
          capabilities: { "notes.purge": "./capabilities/notes-purge.ts" },
          routes: [],
        },
      },
    });

    const graph = await collectAppGraph(server, process.cwd());

    // The CLI's directly imported @pracht/core singleton has no store, but the
    // app registered one in Vite's SSR graph. Only the latter is authoritative.
    expect(graph.mcpUnavailableReasons).toEqual([]);
    expect(graph.mcpRuntimeStatus).toBe("ready");
    expect(destructiveMcpPreconditionErrors).toHaveBeenCalledOnce();
  });

  it("loads applied setup middleware before reading destructive MCP preconditions", async () => {
    let setupLoaded = false;
    const destructiveMcpPreconditionErrors = vi.fn(() =>
      setupLoaded ? [] : ["no approval store is registered."],
    );
    const capability = {
      kind: "capability",
      title: "Purge notes",
      description: "Purge every note.",
      input: { type: "object" },
      output: { type: "object" },
      effect: "destructive",
      expose: { mcp: true },
      middleware: ["approvalSetup"],
      run: async () => ({}),
    };
    const middlewareModule = vi.fn(async () => {
      setupLoaded = true;
      return { middleware: async () => new Response() };
    });
    const server = fakeServer({
      "@pracht/core/server": { destructiveMcpPreconditionErrors },
      "virtual:pracht/dev-metadata": {
        apiRoutes: [],
        registry: {
          capabilityModules: {
            "/src/capabilities/notes-purge.ts": async () => ({ default: capability }),
          },
          middlewareModules: {
            "/src/middleware/approval-setup.ts": middlewareModule,
          },
        },
        resolvedApp: {
          agents: { mcp: { destructive: true } },
          capabilities: { "notes.purge": "./capabilities/notes-purge.ts" },
          middleware: { approvalSetup: "./middleware/approval-setup.ts" },
          routes: [],
        },
      },
    });

    const graph = await collectAppGraph(server, process.cwd());

    expect(middlewareModule).toHaveBeenCalledOnce();
    expect(destructiveMcpPreconditionErrors).toHaveBeenCalledOnce();
    expect(graph.mcpUnavailableReasons).toEqual([]);
    expect(graph.mcpRuntimeStatus).toBe("ready");
  });

  it("resolves API methods re-exported from another module", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-static-api-graph-"));
    mkdirSync(join(root, "src/api-edge"), { recursive: true });
    mkdirSync(join(root, "src/api"), { recursive: true });
    writeFileSync(join(root, "src/api-edge/health.ts"), 'export { GET } from "../api/health.ts";');
    writeFileSync(
      join(root, "src/api/health.ts"),
      'throw new Error("must not execute");\nexport function GET() {}',
    );

    try {
      const server = fakeServer({
        "virtual:pracht/dev-metadata": {
          apiRoutes: [{ file: "/src/api-edge/health.ts", path: "/api/health" }],
          resolvedApp: {
            capabilities: {},
            routes: [],
          },
        },
      });

      await expect(collectAppGraph(server, root)).resolves.toMatchObject({
        api: [
          {
            file: "/src/api-edge/health.ts",
            hasDefaultHandler: false,
            methods: ["GET"],
            path: "/api/health",
          },
        ],
      });
      expect(server.ssrLoadModule).toHaveBeenCalledTimes(1);
      expect(server.ssrLoadModule).not.toHaveBeenCalledWith("/src/api-edge/health.ts");
      expect(server.ssrLoadModule).not.toHaveBeenCalledWith("/src/api/health.ts");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves star re-exports through a relative directory index", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-static-api-index-"));
    mkdirSync(join(root, "src/api-edge"), { recursive: true });
    mkdirSync(join(root, "src/api/handlers"), { recursive: true });
    writeFileSync(join(root, "src/api-edge/health.ts"), 'export * from "../api/handlers";');
    writeFileSync(
      join(root, "src/api/handlers/index.ts"),
      'throw new Error("must not execute");\nexport function GET() {}',
    );

    try {
      const server = fakeServer(
        {
          "virtual:pracht/dev-metadata": {
            apiRoutes: [{ file: "/src/api-edge/health.ts", path: "/api/health" }],
            resolvedApp: {
              capabilities: {},
              routes: [],
            },
          },
        },
        async (specifier) =>
          specifier === "../api/handlers" ? { id: join(root, "src/api/handlers/index.ts") } : null,
      );

      await expect(collectAppGraph(server, root)).resolves.toMatchObject({
        api: [
          {
            file: "/src/api-edge/health.ts",
            hasDefaultHandler: false,
            methods: ["GET"],
            path: "/api/health",
          },
        ],
      });
      expect(server.ssrLoadModule).toHaveBeenCalledTimes(1);
      expect(server.ssrLoadModule).not.toHaveBeenCalledWith("/src/api-edge/health.ts");
      expect(server.ssrLoadModule).not.toHaveBeenCalledWith("/src/api/handlers/index.ts");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses Vite resolution for JS-to-TS and aliased star exports but rejects dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-static-api-vite-resolve-"));
    mkdirSync(join(root, "src/api-edge"), { recursive: true });
    mkdirSync(join(root, "src/api"), { recursive: true });
    mkdirSync(join(root, "node_modules/external-handlers"), { recursive: true });
    writeFileSync(
      join(root, "src/api-edge/health.ts"),
      [
        'export * from "../api/health.js";',
        'export * from "@handlers/metrics";',
        'export * from "external-handlers";',
      ].join("\n"),
    );
    writeFileSync(join(root, "src/api/health.ts"), "export function GET() {}");
    writeFileSync(join(root, "src/api/metrics.ts"), "export function POST() {}");
    writeFileSync(
      join(root, "node_modules/external-handlers/index.ts"),
      "export function DELETE() {}",
    );

    const resolveId = vi.fn(async (specifier: string) => {
      if (specifier === "../api/health.js") return { id: join(root, "src/api/health.ts") };
      if (specifier === "@handlers/metrics") return { id: join(root, "src/api/metrics.ts") };
      if (specifier === "external-handlers") {
        return { id: join(root, "node_modules/external-handlers/index.ts") };
      }
      return null;
    });

    try {
      const server = fakeServer(
        {
          "virtual:pracht/dev-metadata": {
            apiRoutes: [{ file: "/src/api-edge/health.ts", path: "/api/health" }],
            resolvedApp: { capabilities: {}, routes: [] },
          },
        },
        resolveId,
      );

      await expect(collectAppGraph(server, root)).resolves.toMatchObject({
        api: [{ methods: ["GET", "POST"], path: "/api/health" }],
      });
      expect(resolveId).toHaveBeenCalledWith(
        "../api/health.js",
        expect.stringMatching(/\/src\/api-edge\/health\.ts$/),
        { ssr: true },
      );
      expect(resolveId).toHaveBeenCalledWith(
        "@handlers/metrics",
        expect.stringMatching(/\/src\/api-edge\/health\.ts$/),
        { ssr: true },
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
