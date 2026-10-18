import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import {
  installCommand,
  isMissingPackage,
  missingOptionalDependencyError,
} from "../src/optional-dependency.ts";
import { McpToolServer } from "../src/mcp-tool-server.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..");
const cliPath = resolve(packageDir, "bin/pracht.js");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

// Every app installs @pracht/cli. The MCP protocol SDK and Playwright's browser
// driver serve only `pracht dev-mcp` and the WebMCP browser checks, so they
// must not be part of that install.
describe("@pracht/cli agent tooling dependencies", () => {
  it("does not install the MCP SDK or playwright-core with the CLI", () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf-8"));
    expect(Object.keys(manifest.dependencies)).not.toContain("@modelcontextprotocol/sdk");
    expect(Object.keys(manifest.dependencies)).not.toContain("playwright-core");
    expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain("@modelcontextprotocol/sdk");
    expect(manifest.peerDependencies?.["playwright-core"]).toBeTypeOf("string");
    expect(manifest.peerDependenciesMeta?.["playwright-core"]?.optional).toBe(true);
  });

  it("loads playwright-core only when a command launches Chrome", () => {
    const staticImports = sourceFiles(resolve(packageDir, "src")).filter((file) =>
      /^import\s+(?!type\b)[^;]*?from\s+["'](?:playwright-core|@modelcontextprotocol\/[^"']*)["']/m.test(
        readFileSync(file, "utf-8"),
      ),
    );
    expect(staticImports).toEqual([]);
  });

  it("names the install command when playwright-core is missing", () => {
    const missing = Object.assign(
      new Error(
        "Cannot find package 'playwright-core' imported from /app/node_modules/@pracht/cli/dist/x.mjs",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(isMissingPackage(missing, "playwright-core")).toBe(true);
    const transitive = Object.assign(new Error("Cannot find package 'ws' imported from x"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(isMissingPackage(transitive, "playwright-core")).toBe(false);

    expect(installCommand("playwright-core", "pnpm/11.3.0 npm/? node/v22")).toBe(
      "pnpm add -D playwright-core",
    );
    expect(installCommand("playwright-core", "")).toBe("npm install -D playwright-core");
    expect(
      missingOptionalDependencyError("playwright-core", "Driving Chrome for WebMCP checks", missing)
        .message,
    ).toBe(
      "Driving Chrome for WebMCP checks needs playwright-core, which @pracht/cli does not install by default. " +
        `Add it to the app: ${installCommand("playwright-core")}`,
    );
  });
});

describe("pracht dev-mcp over stdio", () => {
  it("serves its tools to an MCP client", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "dev-mcp"],
      cwd: packageDir,
      stderr: "pipe",
    });
    const client = new Client({ name: "pracht-stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("doctor");
      const docs = tools.find((tool) => tool.name === "get_docs");
      expect(docs?.inputSchema.type).toBe("object");

      const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
      expect(unknown.isError).toBe(true);
      const invalid = await client.callTool({ name: "search_docs", arguments: { query: 1 } });
      expect(invalid.isError).toBe(true);
      await expect(client.ping()).resolves.toEqual({});
    } finally {
      await client.close();
    }
  }, 30_000);

  it("answers malformed frames and unknown methods with JSON-RPC errors", async () => {
    const child = spawn(process.execPath, [cliPath, "dev-mcp"], {
      cwd: packageDir,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const frames: Record<string, any>[] = [];
    let buffer = "";
    const received = new Promise<void>((resolveFrames) => {
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
        if (frames.length >= 3) resolveFrames();
      });
    });
    child.stdin.write("{not json\n");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "1999-01-01",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      })}\n`,
    );
    try {
      await received;
      expect(frames).toContainEqual(
        expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) }),
      );
      expect(frames).toContainEqual(
        expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32601 }) }),
      );
      const initialize = frames.find((frame) => frame.id === 2);
      expect(initialize?.result.protocolVersion).toBe("2025-11-25");
      expect(initialize?.result.capabilities.tools).toBeDefined();
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, 30_000);
});

describe("McpToolServer cancellation", () => {
  it("does not answer a request the client cancelled", async () => {
    const sent: Record<string, any>[] = [];
    const transport = {
      onmessage: undefined as ((message: any) => void) | undefined,
      async start() {},
      async send(message: Record<string, any>) {
        sent.push(message);
      },
      async close() {},
    };
    let finish!: () => void;
    const server = new McpToolServer({ name: "test", version: "0" });
    server.registerTool("slow", { description: "slow", inputSchema: {} }, async () => {
      await new Promise<void>((resolveSlow) => {
        finish = resolveSlow;
      });
      return { content: [{ type: "text", text: "done" }] };
    });
    await server.connect(transport);

    transport.onmessage!({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow" } });
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    transport.onmessage!({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });
    finish();
    transport.onmessage!({ jsonrpc: "2.0", id: 8, method: "ping" });
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));

    expect(sent.map((message) => message.id)).toEqual([8]);
  });
});
