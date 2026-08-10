import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

import { pracht, type PrachtAdapter } from "../src/index.ts";

const edgeAdapter: PrachtAdapter = {
  id: "cloudflare",
  edge: true,
  serverImports: "",
  createServerEntryModule: () => "export default {};",
};

// Asserting on the *resolved* config, not on what the hook returns: the bug
// this guards against is a second Preact copy reaching the SSR environment, and
// top-level `resolve.dedupe` only helps there because Vite propagates it into
// `environments.ssr`. A test that reads the hook's return value would stay
// green if that propagation ever stopped — while hook-using components went
// back to failing SSR with `Cannot read properties of undefined (reading
// '__H')`.
describe("preact dedupe", () => {
  it("reaches the ssr environment in a dev server config", async () => {
    const config = await resolveConfig(
      { configFile: false, logLevel: "silent", plugins: [pracht()] },
      "serve",
    );

    expect(config.resolve.dedupe).toContain("preact");
    expect(config.environments.ssr?.resolve.dedupe).toContain("preact");
    expect(config.environments.client?.resolve.dedupe).toContain("preact");
  });

  it("reaches the ssr environment in an edge ssr build, alongside the edge conditions", async () => {
    const config = await resolveConfig(
      {
        build: { ssr: true },
        configFile: false,
        logLevel: "silent",
        plugins: [pracht({ adapter: edgeAdapter })],
      },
      "build",
    );

    expect(config.environments.ssr?.resolve.dedupe).toContain("preact");
    // The plugin overrides ssr resolve conditions for edge builds; dedupe has
    // to survive alongside that override rather than be replaced by it.
    expect(config.environments.ssr?.resolve.conditions).toContain("worker");
  });

  it("keeps a user's own dedupe and alias entries", async () => {
    const config = await resolveConfig(
      {
        configFile: false,
        logLevel: "silent",
        plugins: [pracht()],
        resolve: { alias: { "@app": "/src" }, dedupe: ["lodash-es"] },
      },
      "serve",
    );

    expect(config.resolve.dedupe).toContain("lodash-es");
    expect(config.resolve.dedupe).toContain("preact");
    expect(config.resolve.alias.some((entry) => entry.find === "@app")).toBe(true);
  });
});
