import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { timeRevalidate } from "@pracht/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeBuildAdapter,
  type FinalizeBuildAdapterOptions,
} from "../src/build-adapter-output.ts";

const tempRoots: string[] = [];

function createOptions(
  overrides: Partial<FinalizeBuildAdapterOptions> = {},
): FinalizeBuildAdapterOptions & { logs: string[] } {
  const root = mkdtempSync(join(tmpdir(), "pracht-adapter-output-"));
  mkdirSync(join(root, "dist/client"), { recursive: true });
  mkdirSync(join(root, "dist/server"), { recursive: true });
  writeFileSync(join(root, "dist/client/index.html"), "home", "utf-8");
  writeFileSync(join(root, "dist/server/server.js"), "export default {};\n", "utf-8");
  tempRoots.push(root);

  const logs: string[] = [];
  return {
    buildTarget: null,
    cloudflareWorkerEntrypointNames: [],
    cloudflareWorkersCacheEnabled: false,
    edgeCachedIsgPaths: [],
    generatedStaticRoutes: [],
    headersManifest: {},
    isgManifest: {},
    log: (message) => logs.push(message),
    logs,
    markdownManifest: {},
    nodeListener: undefined,
    pages: [{ path: "/" }],
    root,
    ...overrides,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

describe("finalizeBuildAdapter", () => {
  it("writes a narrow Cloudflare deploy entry and reports Workers Caching", () => {
    const options = createOptions({
      buildTarget: "cloudflare",
      cloudflareWorkerEntrypointNames: ["CounterFacet", "RegistryFacet"],
      cloudflareWorkersCacheEnabled: true,
      edgeCachedIsgPaths: ["/pricing"],
    });

    finalizeBuildAdapter(options);

    expect(readFileSync(join(options.root, "dist/server/worker.js"), "utf-8")).toBe(
      'export { CounterFacet, RegistryFacet } from "./server.js";\n' +
        'export { default } from "./server.js";\n',
    );
    expect(options.logs.join("\n")).toContain("ISG via Workers Caching: 1 route(s)");
    expect(options.logs.join("\n")).toContain("Deploy with: wrangler deploy");
  });

  it("fails Vercel ISG output before emission when nodeListener is missing", () => {
    const options = createOptions({
      buildTarget: "vercel",
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
    });

    expect(() => finalizeBuildAdapter(options)).toThrow(/does not export `nodeListener`/);
  });

  it("includes companion artifacts in Vercel static routing", () => {
    const options = createOptions({
      buildTarget: "vercel",
      generatedStaticRoutes: ["/docs"],
    });

    finalizeBuildAdapter(options);

    const config = JSON.parse(
      readFileSync(join(options.root, ".vercel/output/config.json"), "utf-8"),
    ) as { routes: Array<{ dest?: string; src?: string }> };
    expect(config.routes).toContainEqual({ dest: "/docs/index.html", src: "^/docs/?$" });
    expect(options.logs).toContain("\n  Vercel build output → .vercel/output\n");
  });
});
