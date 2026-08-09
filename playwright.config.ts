import { cpus } from "node:os";

import { defineConfig } from "@playwright/test";

// Most specs are short browser assertions against an already-running dev
// server, so the suite is bound by worker count rather than by CPU. Leave two
// cores for the four dev servers; CI runners are small, so cap them lower.
const workers = process.env.CI ? 4 : Math.min(8, Math.max(3, cpus().length - 2));

export default defineConfig({
  testDir: "./e2e",
  // A ceiling on hangs, not an assertion about latency. The specs that care
  // about timing (pending navigation state, hover prefetch) assert on ordering
  // and request counts; a tight budget here only converts a busy machine into
  // a false failure, and a genuinely broken route still never settles.
  timeout: 20_000,
  workers,
  retries: 0,
  projects: [
    {
      name: "basic",
      testMatch:
        /basic\.test\.ts|navigation\.test\.ts|node-build\.test\.ts|cloudflare-build\.test\.ts|vercel-build\.test\.ts|client-bundle-strip\.test\.ts|tsrx-build\.test\.ts|islands-build\.test\.ts|env-safety\.test\.ts|not-found\.test\.ts/,
      use: {
        baseURL: "http://localhost:3100",
      },
    },
    {
      name: "pages-router",
      testMatch: /pages-router\.test\.ts|dev-404\.test\.ts|llms-txt-dev\.test\.ts/,
      use: {
        baseURL: "http://localhost:3101",
      },
    },
    {
      name: "islands",
      testMatch: /islands-dev\.test\.ts/,
      use: {
        baseURL: "http://localhost:3102",
      },
    },
    {
      name: "capabilities",
      testMatch: /capabilities\.test\.ts/,
      use: {
        baseURL: "http://localhost:3103",
      },
    },
  ],
  webServer: [
    {
      command: "node e2e/start-dev-server.mjs examples/cloudflare 3100",
      port: 3100,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "node e2e/start-dev-server.mjs examples/pages-router 3101",
      port: 3101,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "node e2e/start-dev-server.mjs examples/islands 3102",
      port: 3102,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "node e2e/start-dev-server.mjs examples/basic 3103",
      port: 3103,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        // Enables the destructive-capability confirmation flow that
        // e2e/capabilities.test.ts and the example eval scenario exercise.
        PRACHT_CONFIRMATION_SECRET: "pracht-e2e-confirmation-secret",
      },
    },
  ],
});
