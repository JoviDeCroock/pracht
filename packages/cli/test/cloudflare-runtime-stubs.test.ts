import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { load, PRERENDER_STUB_MODULES } from "../src/prerender-module-hooks.ts";

// Both Node-side stub sets (prerendering in @pracht/cli, graph commands in
// @pracht/adapter-cloudflare) must offer every export the real workerd module
// has, or an app importing it cannot build. Enumerate the installed runtime
// instead of trusting a hand-written list, so a workerd upgrade that adds an
// export fails here first.

/** Runtime exports that are internal to workerd and never imported by apps. */
const INTERNAL_RUNTIME_EXPORTS = new Set(["cloudflare:sockets internalNewHttpClient"]);

/**
 * Stub exports the installed runtime does not have: APIs from newer runtimes
 * (`cache`, `tracing`) and a legacy re-export kept so older imports link.
 */
const EXTRA_STUB_EXPORTS = new Set([
  "cloudflare:workers cache",
  "cloudflare:workers tracing",
  "cloudflare:workflows WorkflowEntrypoint",
]);

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const requireFromExample = createRequire(resolve(repoRoot, "examples/cloudflare/package.json"));

async function importSource(source: string): Promise<Record<string, unknown>> {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function runtimeExports(modules: readonly string[]): Promise<Record<string, string[]>> {
  const miniflarePath = createRequire(requireFromExample.resolve("wrangler")).resolve("miniflare");
  const { Miniflare, supportedCompatibilityDate } = await import(pathToFileURL(miniflarePath).href);
  const script = [
    ...modules.map((name, index) => `import * as m${index} from ${JSON.stringify(name)};`),
    "export default { fetch() { return Response.json({",
    ...modules.map((name, index) => `  ${JSON.stringify(name)}: Object.keys(m${index}),`),
    "}); } };",
  ].join("\n");
  const miniflare = new Miniflare({
    modules: true,
    script,
    compatibilityDate: supportedCompatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
  });
  try {
    const response = await miniflare.dispatchFetch("http://localhost/");
    return (await response.json()) as Record<string, string[]>;
  } finally {
    await miniflare.dispose();
  }
}

async function prerenderStubExports(name: string): Promise<string[]> {
  const result = load(`pracht-cloudflare-stub:${name}`, {}, () => {
    throw new Error(`no prerender stub for ${name}`);
  }) as { source: string };
  return Object.keys(await importSource(result.source));
}

async function graphStubPlugin() {
  const { cloudflareAdapter } = await import(
    pathToFileURL(requireFromExample.resolve("@pracht/adapter-cloudflare")).href
  );
  return cloudflareAdapter()
    .graphVitePlugins()
    .find(
      (candidate: { name: string }) => candidate.name === "pracht:cloudflare-graph-runtime-stubs",
    );
}

async function graphStubExports(name: string): Promise<string[]> {
  const plugin = await graphStubPlugin();
  const id = await plugin.resolveId.call({}, name, undefined, { isEntry: false });
  return Object.keys(await importSource(String(await plugin.load.call({}, id))));
}

function qualified(name: string, exports: string[]): string[] {
  return exports.map((exportName) => `${name} ${exportName}`).sort();
}

describe("Cloudflare runtime module stubs", () => {
  let runtime: Record<string, string[]>;

  beforeAll(async () => {
    runtime = await runtimeExports(PRERENDER_STUB_MODULES);
  }, 60_000);

  it.each(PRERENDER_STUB_MODULES)("%s matches the workerd runtime exports", async (name) => {
    const expected = qualified(name, runtime[name] ?? [])
      .filter((entry) => !INTERNAL_RUNTIME_EXPORTS.has(entry))
      .concat([...EXTRA_STUB_EXPORTS].filter((entry) => entry.startsWith(`${name} `)))
      .sort();

    expect(qualified(name, await prerenderStubExports(name))).toEqual(expected);
    expect(qualified(name, await graphStubExports(name))).toEqual(expected);
  });

  it("stubs the same modules for prerendering and graph commands", async () => {
    const plugin = await graphStubPlugin();
    let message = "";
    try {
      plugin.resolveId.call({}, "cloudflare:not-a-module", undefined, { isEntry: false });
    } catch (error) {
      message = (error as Error).message;
    }
    const supported = /Supported Cloudflare runtime modules: (.+)\./.exec(message)?.[1];
    expect(supported?.split(", ").sort()).toEqual([...PRERENDER_STUB_MODULES].sort());
  });
});
