import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

import { pracht, type PrachtAdapter } from "../src/index.ts";

const nodeAdapter: PrachtAdapter = {
  id: "node",
  serverImports: "",
  createServerEntryModule: () => "export default {};",
};

function matches(
  noExternal: boolean | string | RegExp | Array<string | RegExp> | undefined,
  id: string,
): boolean {
  if (noExternal === true) return true;
  const entries = Array.isArray(noExternal) ? noExternal : [noExternal];
  return entries.some((entry) =>
    entry instanceof RegExp ? entry.test(id) : typeof entry === "string" && entry === id,
  );
}

// Asserting on the *resolved* config: the bug this guards against is the dev
// SSR environment holding a second copy of the runtime. `pracht dev` renders
// through `ssrLoadModule("@pracht/core/server")` — always inlined — while the
// app's own `import { useLocation } from "@pracht/core"` is a bare
// node_modules id Vite would externalize to a native Node import. Two copies
// means two `createContext()` objects, so the document renders with one
// provider and every component reads the other one's empty default.
describe("pracht runtime noExternal", () => {
  it("keeps @pracht packages inlined in the dev ssr environment", async () => {
    const config = await resolveConfig(
      { configFile: false, logLevel: "silent", plugins: [pracht({ adapter: nodeAdapter })] },
      "serve",
    );

    expect(matches(config.environments.ssr?.resolve.noExternal, "@pracht/core")).toBe(true);
    expect(matches(config.environments.ssr?.resolve.noExternal, "@pracht/content")).toBe(true);
  });

  it("keeps @pracht packages inlined in a node ssr build", async () => {
    const config = await resolveConfig(
      {
        build: { ssr: true },
        configFile: false,
        logLevel: "silent",
        plugins: [pracht({ adapter: nodeAdapter })],
      },
      "build",
    );

    expect(matches(config.environments.ssr?.resolve.noExternal, "@pracht/core")).toBe(true);
  });

  it("keeps a user's own noExternal entries", async () => {
    const config = await resolveConfig(
      {
        configFile: false,
        logLevel: "silent",
        plugins: [pracht({ adapter: nodeAdapter })],
        ssr: { noExternal: ["some-esm-only-package"] },
      },
      "serve",
    );

    expect(matches(config.environments.ssr?.resolve.noExternal, "some-esm-only-package")).toBe(
      true,
    );
    expect(matches(config.environments.ssr?.resolve.noExternal, "@pracht/core")).toBe(true);
  });
});
