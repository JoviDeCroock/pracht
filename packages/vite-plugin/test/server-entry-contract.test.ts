import { readServerEntry, type PrachtAdapter } from "@pracht/core/adapter";
import { init, parse } from "es-module-lexer";
import { beforeAll, describe, expect, it } from "vitest";

import { cloudflareAdapter } from "../../adapter-cloudflare/src/index.ts";
import { netlifyAdapter } from "../../adapter-netlify/src/index.ts";
import { nodeAdapter } from "../../adapter-node/src/index.ts";
import { staticAdapter } from "../../adapter-static/src/index.ts";
import { vercelAdapter } from "../../adapter-vercel/src/index.ts";
import { createDefaultNodeAdapter } from "../src/plugin-adapter.ts";
import { createPrachtServerModuleSource } from "../src/plugin-codegen.ts";

// The producer side of the server entry contract: the module the plugin and
// each adapter generate together must pass the read `pracht build` does.
const adapters: Array<[string, () => PrachtAdapter]> = [
  ["node", () => nodeAdapter()],
  ["default node", () => createDefaultNodeAdapter()],
  ["cloudflare", () => cloudflareAdapter()],
  ["netlify", () => netlifyAdapter()],
  ["vercel", () => vercelAdapter()],
  ["static", () => staticAdapter()],
];

const CONTRACT_EXPORTS = [
  "contract",
  "buildId",
  "adapterId",
  "features",
  "buildTarget",
  "headersManifestFormat",
];

/** The literal values the entry exports for the contract, read from its source. */
function readContractExports(source: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const name of CONTRACT_EXPORTS) {
    const match = new RegExp(`^export const ${name} = (.+);$`, "m").exec(source);
    if (match) values[name] = JSON.parse(match[1]!);
  }
  return values;
}

beforeAll(async () => {
  await init;
});

describe("generated server entries", () => {
  it.each(adapters)("%s: passes readServerEntry with its own adapter id", (_label, create) => {
    const adapter = create();
    const source = createPrachtServerModuleSource({ adapter }, { buildId: "build-1" });

    const [, exports] = parse(source);
    const names = exports.map((entry) => entry.n);
    // A name exported twice is a syntax error the bundler reports far from here.
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    for (const name of ["contract", "buildId", "adapterId", "features", "buildTarget"]) {
      expect(names).toContain(name);
    }

    const entry = readServerEntry({
      ...readContractExports(source),
      resolvedApp: { routes: [] },
      prerenderApp: () => [],
    });
    expect(entry).toMatchObject({
      contract: 1,
      buildId: "build-1",
      adapterId: adapter.id,
      features: { headersManifest: adapter.features?.headersManifest ?? 1 },
    });
  });

  it.each(adapters)("%s: hands the build id to the adapter's runtime", (_label, create) => {
    const adapter = create();
    let received: unknown;
    const spy: PrachtAdapter = {
      ...adapter,
      createServerEntryModule(entry) {
        received = entry;
        return adapter.createServerEntryModule(entry);
      },
    };
    createPrachtServerModuleSource({ adapter: spy }, { buildId: "build-2" });
    expect(received).toEqual({ buildId: "build-2" });
  });

  it("keeps the legacy headers-manifest export for adapters that read the shared form", () => {
    const source = createPrachtServerModuleSource({ adapter: nodeAdapter() }, { buildId: "b" });
    expect(source).toContain("export const headersManifestFormat = 2;");
    expect(source).toContain('export const features = {"headersManifest":2};');
  });

  it("does not repeat the legacy export an adapter released before `features` emits", () => {
    const legacyAdapter: PrachtAdapter = {
      id: "legacy",
      serverImports: "",
      createServerEntryModule: () => "export const headersManifestFormat = 2;\n",
    };
    const source = createPrachtServerModuleSource({ adapter: legacyAdapter }, { buildId: "b" });
    expect(source.match(/export const headersManifestFormat/g)).toHaveLength(1);
    const entry = readServerEntry({
      ...readContractExports(source),
      resolvedApp: { routes: [] },
      prerenderApp: () => [],
    });
    expect(entry.features.headersManifest).toBe(2);
  });
});
