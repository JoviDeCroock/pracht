import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";

interface OptimizeDepsConfig {
  root?: string;
  optimizeDeps?: { entries?: string[]; include?: string[] };
  environments?: Record<string, { optimizeDeps?: { entries?: string[]; include?: string[] } }>;
}

// An app layout where @pracht/core is installed from npm (resolves through
// node_modules), unlike this monorepo where the package is workspace-linked.
const npmAppRoot = fileURLToPath(new URL("./fixtures/npm-app", import.meta.url));

function runOptimizeDepsHook(userConfig: OptimizeDepsConfig): OptimizeDepsConfig {
  const plugin = pracht().find((candidate) => candidate.name === "pracht:optimize-deps-entries");
  if (!plugin) throw new Error("optimize-deps plugin not found");
  const hook = plugin.config as (config: OptimizeDepsConfig) => OptimizeDepsConfig;
  return hook.call(plugin as never, userConfig);
}

describe("pracht optimizeDeps config", () => {
  it("pre-bundles the virtual client entry dependencies for npm-installed apps", () => {
    const config = runOptimizeDepsHook({ root: npmAppRoot });

    expect(config.optimizeDeps?.include).toContain("@pracht/core");
    expect(config.optimizeDeps?.include).toContain("@pracht/core/client");
    expect(config.optimizeDeps?.include).toContain("@pracht/core/manifest");
  });

  it("preserves user-configured includes without duplicating entries", () => {
    const config = runOptimizeDepsHook({
      root: npmAppRoot,
      optimizeDeps: { include: ["preact", "@pracht/core/client"] },
    });

    expect(config.optimizeDeps?.include).toContain("preact");
    const clientEntries = config.optimizeDeps?.include?.filter(
      (entry) => entry === "@pracht/core/client",
    );
    expect(clientEntries).toHaveLength(1);
  });

  it("skips the includes when @pracht/core is workspace-linked", () => {
    // In this monorepo the package resolves to packages/framework, not
    // node_modules; Vite treats linked packages as source, and force-including
    // only some entries would split the runtime into two copies.
    const config = runOptimizeDepsHook({});

    expect(config.optimizeDeps?.include).toBeUndefined();
  });

  it("still contributes scan entries for route and shell files", () => {
    const config = runOptimizeDepsHook({ root: npmAppRoot });

    expect(config.optimizeDeps?.entries?.some((entry) => entry.includes("src/routes"))).toBe(true);
  });
});
