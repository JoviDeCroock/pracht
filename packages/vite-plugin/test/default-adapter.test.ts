import { describe, expect, it } from "vitest";

import { createDefaultNodeAdapter } from "../src/plugin-adapter.ts";

describe("createDefaultNodeAdapter", () => {
  it("uses the shared Node server entry generator with prerender header manifest support", () => {
    const source = createDefaultNodeAdapter().createServerEntryModule();

    expect(source).toContain(
      'const headersManifestPath = resolve(serverDir, "headers-manifest.json");',
    );
    expect(source).toContain("headersManifest,");
    expect(source).toContain("createNodeRequestHandler");
  });
});
