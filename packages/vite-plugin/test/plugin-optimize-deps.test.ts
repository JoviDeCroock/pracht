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

  it("scans the app root, which the client entry imports eagerly", () => {
    // Without it, a dependency only the root imports (`@pracht/query/root`)
    // is discovered on the first page load: 504 "Outdated Optimize Dep", then
    // a full reload.
    expect(runOptimizeDepsHook({ root: npmAppRoot }).optimizeDeps?.entries).toContain(
      "src/root.{ts,tsx,js,jsx}",
    );

    const plugin = pracht({ rootFile: "/app/root" }).find(
      (candidate) => candidate.name === "pracht:optimize-deps-entries",
    )!;
    const hook = plugin.config as (config: OptimizeDepsConfig) => OptimizeDepsConfig;
    expect(hook.call(plugin as never, {}).optimizeDeps?.entries).toContain(
      "app/root.{ts,tsx,js,jsx}",
    );
  });

  it("still contributes scan entries for route and shell files", () => {
    const config = runOptimizeDepsHook({ root: npmAppRoot });

    expect(config.optimizeDeps?.entries?.some((entry) => entry.includes("src/routes"))).toBe(true);
  });
});
