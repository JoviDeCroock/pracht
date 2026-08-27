import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCli,
  writeInspectableManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli inspect", () => {
  it("inspects resolved routes, api handlers, and build metadata as JSON", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-");
    writeInspectableManifestApp(appDir);

    const routes = JSON.parse(runCli(["inspect", "routes", "--json"], { cwd: appDir }).stdout);
    const api = JSON.parse(runCli(["inspect", "api", "--json"], { cwd: appDir }).stdout);
    const build = JSON.parse(runCli(["inspect", "build", "--json"], { cwd: appDir }).stdout);
    const all = JSON.parse(runCli(["inspect", "--json"], { cwd: appDir }).stdout);

    expect(routes).toEqual({
      mode: "manifest",
      notFound: null,
      routes: [
        {
          file: "./routes/dashboard.tsx",
          hydration: "full",
          hydrationEffective: "full",
          id: "dashboard",
          loaderCache: null,
          loaderFile: "./server/dashboard-loader.ts",
          middleware: ["auth"],
          path: "/dashboard",
          prefetch: "hover",
          render: "isg",
          revalidate: {
            kind: "time",
            seconds: 60,
          },
          shell: "app",
          shellFile: "./shells/app.tsx",
          speculation: "prefetch",
        },
      ],
    });

    expect(api).toEqual({
      api: [
        {
          file: "/src/api/health.ts",
          hasDefaultHandler: false,
          methods: ["GET", "POST"],
          path: "/api/health",
        },
        {
          file: "/src/api/webhook.ts",
          hasDefaultHandler: true,
          methods: [],
          path: "/api/webhook",
        },
      ],
      mode: "manifest",
    });

    expect(build).toEqual({
      build: {
        adapterTarget: "node",
        clientEntryUrl: "/assets/client.js",
        cssManifest: {
          "src/routes/dashboard.tsx": ["/assets/dashboard.css"],
          "src/shells/app.tsx": ["/assets/app.css"],
        },
        jsManifest: {
          "src/routes/dashboard.tsx": ["/assets/dashboard.js", "/assets/vendor.js"],
          "src/shells/app.tsx": ["/assets/app.js", "/assets/vendor.js"],
          "virtual:pracht/client": ["/assets/vendor.js"],
        },
      },
      mode: "manifest",
    });

    const capabilities = JSON.parse(
      runCli(["inspect", "capabilities", "--json"], { cwd: appDir }).stdout,
    );
    expect(capabilities).toEqual({
      capabilities: [],
      mcpDestructive: false,
      mcpEndpoint: null,
      mcpRuntimeStatus: "not-configured",
      mcpUnavailableReasons: [],
      mode: "manifest",
    });

    const agents = JSON.parse(runCli(["inspect", "agents", "--json"], { cwd: appDir }).stdout);
    // An app that configures nothing agent-facing must read as an app with no
    // agent surface, not as an app with unknown defaults.
    expect(agents).toEqual({
      agents: {
        webBotAuth: { enabled: false, policy: "observe", staticKeys: 0, directories: [] },
        confirmation: { mode: "token", ttlSeconds: null, singleUse: false },
        mcp: { enabled: false, endpoint: null, authenticated: false, auth: null },
        llmsTxt: { enabled: false },
        capabilities: [],
        exposure: { http: 0, webmcp: 0, mcp: 0, private: 0 },
      },
      mcpDestructive: false,
      mcpEndpoint: null,
      mcpRuntimeStatus: "not-configured",
      mcpUnavailableReasons: [],
      mode: "manifest",
    });

    expect(all).toEqual({
      ...routes,
      ...api,
      ...capabilities,
      ...agents,
      ...build,
    });
  }, 30_000);

  it("reports destructive MCP runtime availability in JSON and text output", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-mcp-");
    writeInspectableManifestApp(appDir, { destructiveMcp: true });

    const result = JSON.parse(
      runCli(["inspect", "capabilities", "--json"], { cwd: appDir }).stdout,
    );

    expect(result).toMatchObject({
      mcpDestructive: true,
      mcpEndpoint: "/mcp",
      mcpRuntimeStatus: "unverified",
      mcpUnavailableReasons: expect.arrayContaining([
        expect.stringContaining("no approval store is registered"),
      ]),
    });
    expect(result.capabilities).toEqual([
      expect.objectContaining({
        effect: "destructive",
        name: "notes.purge",
        transports: ["mcp"],
      }),
    ]);

    const agents = JSON.parse(runCli(["inspect", "agents", "--json"], { cwd: appDir }).stdout);
    expect(agents).toMatchObject({
      mcpDestructive: true,
      mcpEndpoint: "/mcp",
      mcpRuntimeStatus: "unverified",
      mcpUnavailableReasons: expect.arrayContaining([
        expect.stringContaining("no approval store is registered"),
      ]),
    });

    const text = runCli(["inspect", "capabilities"], { cwd: appDir }).stdout;
    expect(text).toContain("transports=mcp(unverified)");
    expect(text).toContain("MCP endpoint: /mcp");
    expect(text).toContain("MCP endpoint unverified: no approval store is registered");
    expect(text).toContain("Registrations in the adapter server entry are not evaluated");

    const agentText = runCli(["inspect", "agents"], { cwd: appDir }).stdout;
    expect(agentText).toContain("transports=mcp(unverified)");
    expect(agentText).toContain("MCP endpoint: /mcp");
    expect(agentText).toContain("MCP endpoint unverified: no approval store is registered");

    const disabledDir = createRepoTempDir("pracht-cli-inspect-mcp-disabled-");
    writeInspectableManifestApp(disabledDir, {
      destructiveMcp: true,
      destructiveMcpOptIn: false,
    });
    const disabled = JSON.parse(
      runCli(["inspect", "agents", "--json"], { cwd: disabledDir }).stdout,
    );
    expect(disabled).toMatchObject({
      mcpDestructive: false,
      mcpEndpoint: "/mcp",
      mcpRuntimeStatus: "ready",
      mcpUnavailableReasons: [],
    });
    expect(disabled.agents.capabilities).toEqual([
      expect.objectContaining({
        effect: "destructive",
        name: "notes.purge",
        transports: ["mcp"],
      }),
    ]);
    expect(runCli(["inspect", "agents"], { cwd: disabledDir }).stdout).toContain(
      "transports=mcp(unserved)",
    );
  }, 30_000);

  it("reports build asset URLs under the configured Vite base", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-base-");
    writeInspectableManifestApp(appDir, { base: "/app/" });

    const build = JSON.parse(runCli(["inspect", "build", "--json"], { cwd: appDir }).stdout);

    expect(build.build.clientEntryUrl).toBe("/app/assets/client.js");
    expect(build.build.cssManifest["src/routes/dashboard.tsx"]).toEqual([
      "/app/assets/dashboard.css",
    ]);
    expect(build.build.jsManifest["virtual:pracht/client"]).toEqual(["/app/assets/vendor.js"]);
  }, 30_000);
});
