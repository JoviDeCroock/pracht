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
    expect(source).toContain("await createPrachtContext({ request, env, executionContext })");
    expect(source).toContain("context,");
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

  it("bypasses static assets for the _data route-state transport", () => {
    const source = createCloudflareServerEntryModule();

    expect(source).toContain('url.searchParams.get("_data") === "1"');
  });
});
