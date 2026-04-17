import { describe, expect, it } from "vitest";

import { createCloudflareServerEntryModule } from "../src/index.ts";

describe("createCloudflareServerEntryModule", () => {
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
});
