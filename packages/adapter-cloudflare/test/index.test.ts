import { describe, expect, it } from "vitest";

import { createCloudflareServerEntryModule } from "../src/index.ts";

describe("createCloudflareServerEntryModule", () => {
  it("re-exports Cloudflare primitives from a dedicated module", () => {
    const source = createCloudflareServerEntryModule({
      workerExportsFrom: "/src/cloudflare.ts",
    });

    expect(source).toContain('export * from "/src/cloudflare.ts";');
  });

  it("rejects mixing workerExportsFrom with deprecated named exports", () => {
    expect(() =>
      createCloudflareServerEntryModule({
        workerExportsFrom: "/src/cloudflare.ts",
        exports: [{ from: "/src/workers/counter.ts", names: ["Counter"] }],
      }),
    ).toThrow(/workerExportsFrom/);
  });

  it("keeps deprecated named exports working", () => {
    const source = createCloudflareServerEntryModule({
      exports: [{ from: "/src/workers/counter.ts", names: ["Counter"] }],
    });

    expect(source).toContain('export { Counter } from "/src/workers/counter.ts";');
  });
});
