import { describe, expect, it } from "vitest";

import { pracht, type PrachtAdapter } from "../src/index.ts";

const edgeAdapter: PrachtAdapter = {
  id: "cloudflare",
  edge: true,
  serverImports: "",
  createServerEntryModule: () => "export default {};",
};

interface BuildConfig {
  ssr?: { noExternal?: boolean; target?: string };
  build?: {
    rollupOptions?: {
      external?: unknown[];
      output?: { manualChunks?: unknown };
    };
  };
}

function runConfigHook(adapter: PrachtAdapter, isSsrBuild: boolean): BuildConfig {
  const plugin = pracht({ adapter }).find((candidate) => candidate.name === "pracht");
  if (!plugin) throw new Error("pracht plugin not found");
  const hook = plugin.config as (
    config: Record<string, unknown>,
    env: { command: string; mode: string; isSsrBuild: boolean },
  ) => BuildConfig;
  return hook.call(plugin as never, {}, { command: "build", mode: "production", isSsrBuild });
}

describe("pracht plugin build config", () => {
  it("targets webworker and externalizes platform-scheme modules for edge SSR builds", () => {
    const config = runConfigHook(edgeAdapter, true);

    expect(config.ssr?.noExternal).toBe(true);
    expect(config.ssr?.target).toBe("webworker");
    const external = config.build?.rollupOptions?.external ?? [];
    expect(
      external.some((entry) => entry instanceof RegExp && entry.test("cloudflare:workers")),
    ).toBe(true);
  });

  it("keeps the vendor manualChunks split on client builds only", () => {
    const clientConfig = runConfigHook(edgeAdapter, false);
    const ssrConfig = runConfigHook(edgeAdapter, true);

    expect(typeof clientConfig.build?.rollupOptions?.output?.manualChunks).toBe("function");
    expect(ssrConfig.build?.rollupOptions?.output?.manualChunks).toBeUndefined();
  });

  it("does not force edge SSR options on non-edge adapters", () => {
    const nodeLikeAdapter: PrachtAdapter = { ...edgeAdapter, id: "node", edge: false };
    const config = runConfigHook(nodeLikeAdapter, true);

    expect(config.ssr).toBeUndefined();
  });
});
