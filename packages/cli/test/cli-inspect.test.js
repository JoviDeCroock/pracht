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
    expect(capabilities).toEqual({ capabilities: [], mode: "manifest" });

    const agents = JSON.parse(runCli(["inspect", "agents", "--json"], { cwd: appDir }).stdout);
    // An app that configures nothing agent-facing must read as an app with no
    // agent surface, not as an app with unknown defaults.
    expect(agents).toEqual({
      agents: {
        webBotAuth: { enabled: false, policy: "observe", staticKeys: 0, directories: [] },
        confirmation: { mode: "token", ttlSeconds: null, singleUse: false },
        mcp: { enabled: false, endpoint: null },
        llmsTxt: { enabled: false },
        capabilities: [],
        exposure: { http: 0, webmcp: 0, mcp: 0, private: 0 },
      },
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
