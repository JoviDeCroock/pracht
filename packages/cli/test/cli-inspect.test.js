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

    expect(all).toEqual({
      ...routes,
      ...api,
      ...capabilities,
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
