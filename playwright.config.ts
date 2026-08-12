import { cpus } from "node:os";

import { defineConfig } from "@playwright/test";

import {
  E2E_INSPECTOR_PORT_ENV,
  E2E_LEASE_PATH_ENV,
  E2E_LEASE_TOKEN_ENV,
  E2E_PORT_BASE_ENV,
  acquireE2EPortLease,
  portsForBase,
  registerE2EPortLeaseProcessExit,
  urlsForPorts,
} from "./e2e/ports.ts";

const portLease = acquireE2EPortLease();
process.env[E2E_PORT_BASE_ENV] = String(portLease.portBase);
process.env[E2E_INSPECTOR_PORT_ENV] = String(portLease.portBase + 4);
process.env[E2E_LEASE_PATH_ENV] = portLease.leasePath;
process.env[E2E_LEASE_TOKEN_ENV] = portLease.token;
// Playwright tears down webServer plugins before its config process exits.
// Releasing here keeps the block owned until every listener has stopped.
registerE2EPortLeaseProcessExit(portLease);
const e2ePorts = portsForBase(portLease.portBase);
const e2eUrls = urlsForPorts(e2ePorts);

// Most specs are short browser assertions against an already-running dev
// server, so the suite is bound by worker count rather than by CPU. Leave two
// cores for the four dev servers; CI runners are small, so cap them lower.
const workers = process.env.CI ? 4 : Math.min(8, Math.max(3, cpus().length - 2));

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
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
        /basic\.test\.ts|navigation\.test\.ts|node-build\.test\.ts|cloudflare-build\.test\.ts|vercel-build\.test\.ts|pages-isg-build\.test\.ts|generated-artifact-collision\.test\.ts|client-bundle-strip\.test\.ts|tsrx-build\.test\.ts|islands-build\.test\.ts|env-safety\.test\.ts|not-found\.test\.ts|openapi-cloudflare-dev\.test\.ts/,
      use: {
        baseURL: e2eUrls.basic,
      },
    },
    {
      name: "pages-router",
      testMatch:
        /pages-router\.test\.ts|dev-404\.test\.ts|llms-txt-dev\.test\.ts|openapi-dev\.test\.ts/,
      use: {
        baseURL: e2eUrls.pagesRouter,
      },
    },
    {
      name: "islands",
      testMatch: /islands-dev\.test\.ts/,
      use: {
        baseURL: e2eUrls.islands,
      },
    },
    {
      name: "capabilities",
      testMatch: /capabilities\.test\.ts/,
      use: {
        baseURL: e2eUrls.capabilities,
      },
    },
  ],
  webServer: [
    {
      command: `node e2e/start-dev-server.mjs examples/cloudflare ${e2ePorts.basic}`,
      port: e2ePorts.basic,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node e2e/start-dev-server.mjs examples/pages-router ${e2ePorts.pagesRouter}`,
      port: e2ePorts.pagesRouter,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node e2e/start-dev-server.mjs examples/islands ${e2ePorts.islands}`,
      port: e2ePorts.islands,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node e2e/start-dev-server.mjs examples/basic ${e2ePorts.capabilities}`,
      port: e2ePorts.capabilities,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Enables the destructive-capability confirmation flow that
        // e2e/capabilities.test.ts and the example eval scenario exercise.
        PRACHT_CONFIRMATION_SECRET: "pracht-e2e-confirmation-secret",
      },
    },
  ],
});
