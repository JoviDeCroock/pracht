import { describe, expect, it } from "vitest";

import { createCloudflareServerEntryModule } from "../src/index.ts";

describe("createCloudflareServerEntryModule", () => {
  it("imports an app createContext module when configured", () => {
    const source = createCloudflareServerEntryModule({
      createContextFrom: "/src/server/context.ts",
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain("createContext: createPrachtContext");
    expect(source).toContain("createCloudflareFetchHandler");
  });

  it("re-exports Cloudflare primitives from a dedicated module", () => {
    const source = createCloudflareServerEntryModule({
      workerExportsFrom: "/src/cloudflare.ts",
    });

    expect(source).toContain('export * from "/src/cloudflare.ts";');
  });

  it("omits worker primitive re-exports when no module is configured", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).not.toContain("export * from");
  });

  it("merges worker handlers from a dedicated module into the default export", () => {
    const source = createCloudflareServerEntryModule({
      workerHandlersFrom: "/src/worker-handlers.ts",
    });

    expect(source).toContain('import * as prachtWorkerHandlers from "/src/worker-handlers.ts";');
    expect(source).toContain("export default { ...prachtWorkerHandlers, fetch };");
  });

  it("keeps the default export shape stable when no handlers module is configured", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain("const prachtWorkerHandlers = {};");
    expect(source).toContain("export default { ...prachtWorkerHandlers, fetch };");
  });

  it("bypasses static assets for the _data route-state transport", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain("_pracht/isg.json");
  });

  it("wires Workers Caching for ISG routes when enabled", () => {
    const source = createCloudflareServerEntryModule({ cache: true });

    // The runtime handler owns the cache logic — the entry only threads the
    // option through and flags the build (snapshot skipping keys off it).
    expect(source).toContain("export const cloudflareWorkersCacheEnabled = true;");
    expect(source).toContain("cache: true,");
  });

  it("passes a custom stale-while-revalidate window through to the handler", () => {
    const source = createCloudflareServerEntryModule({ cache: { staleWhileRevalidate: 60 } });

    expect(source).toContain('cache: {"staleWhileRevalidate":60},');
  });

  it("leaves Workers Caching out when not enabled", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain("export const cloudflareWorkersCacheEnabled = false;");
    expect(source).toContain("cache: false,");
  });
});
