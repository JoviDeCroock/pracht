import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 5_000,
  workers: 3,
  retries: 0,
  projects: [
    {
      name: "basic",
      testMatch:
        /basic\.test\.ts|node-build\.test\.ts|cloudflare-build\.test\.ts|vercel-build\.test\.ts|client-bundle-strip\.test\.ts/,
      use: {
        baseURL: "http://localhost:3100",
      },
    },
    {
      name: "pages-router",
      testMatch: /pages-router\.test\.ts/,
      use: {
        baseURL: "http://localhost:3101",
      },
    },
  ],
  webServer: [
    {
      command:
        "cd examples/cloudflare && PORT=3100 NODE_OPTIONS='--experimental-strip-types' node ../../packages/cli/bin/pracht.js dev",
      port: 3100,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command:
        "cd examples/pages-router && PORT=3101 NODE_OPTIONS='--experimental-strip-types' node ../../packages/cli/bin/pracht.js dev",
      port: 3101,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
  ],
});
