import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fast-refresh-app");

/**
 * Route and shell modules reach the browser as `?pracht-client` variants so
 * pracht's post transform can strip server-only exports. `@prefresh/vite`
 * filters on ids ending in `.tsx`, so it skipped exactly those modules: no
 * `import.meta.hot.accept` was injected, and with no self-accepting boundary
 * every route edit escalated to a full page reload.
 */
describe("Fast Refresh for route and shell modules", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await createViteServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [pracht()],
      optimizeDeps: { noDiscovery: true },
      root: FIXTURE_ROOT,
      // No watcher: the test only transforms modules, and a live watcher keeps
      // the process alive past `close()`.
      server: { middlewareMode: true, watch: null },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it("injects a self-accepting Fast Refresh boundary into the client route module", async () => {
    const result = await server.transformRequest("/src/routes/home.tsx?pracht-client");

    expect(result?.code).toContain("import.meta.hot.accept");
    expect(result?.code).toContain("$RefreshReg$");
  });

  it("does the same for shells", async () => {
    const result = await server.transformRequest("/src/shells/public.tsx?pracht-client");

    expect(result?.code).toContain("import.meta.hot.accept");
  });

  // The server-only exports are still gone: Fast Refresh must not be bought by
  // shipping the loader to the browser.
  it("keeps stripping server-only exports from the client module", async () => {
    const result = await server.transformRequest("/src/routes/home.tsx?pracht-client");

    expect(result?.code).not.toContain('greeting: "hello"');
  });

  it("leaves the SSR module without a refresh runtime", async () => {
    const result = await server.transformRequest("/src/routes/home.tsx", { ssr: true });

    expect(result?.code).not.toContain("$RefreshReg$");
    expect(result?.code).toContain('greeting: "hello"');
  });
});
