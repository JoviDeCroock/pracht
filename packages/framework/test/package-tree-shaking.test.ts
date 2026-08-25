import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { build, createLogger } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const frameworkRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "pracht-tree-shaking-"));
const outputDir = join(tempRoot, "dist");
const browserEntry = join(outputDir, "browser.mjs");
const clientEntry = join(outputDir, "client.mjs");
const serverEntry = join(outputDir, "server.mjs");

type FrameworkPackage = {
  peerDependencies?: Record<string, string>;
  sideEffects?: boolean | string[];
};

const packageJson = JSON.parse(
  readFileSync(join(frameworkRoot, "package.json"), "utf-8"),
) as FrameworkPackage;

beforeAll(() => {
  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ type: "module", sideEffects: packageJson.sideEffects }),
    "utf-8",
  );

  execFileSync("pnpm", ["exec", "tsdown", "--config", "tsdown.config.ts", "--out-dir", outputDir], {
    cwd: frameworkRoot,
    stdio: "pipe",
  });
}, 30_000);

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

async function bundleExport(
  exportName: string,
  options: { define?: Record<string, string>; entry?: string } = {},
): Promise<{ code: string; gzipBytes: number; warnings: string[] }> {
  const entry = options.entry ?? browserEntry;
  const publicId = "virtual:pracht-tree-shaking-entry";
  const resolvedId = `\0${publicId}`;
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => warnings.push(message);
  logger.warnOnce = (message) => warnings.push(message);
  const result = await build({
    configFile: false,
    customLogger: logger,
    define: {
      __PRACHT_PUBLIC_ENV__: "{}",
      ...options.define,
    },
    plugins: [
      {
        name: "pracht-tree-shaking-test",
        resolveId(id) {
          if (id === publicId) return resolvedId;
        },
        load(id) {
          if (id !== resolvedId) return;
          return `export { ${exportName} } from ${JSON.stringify(pathToFileURL(entry).href)};`;
        },
      },
    ],
    build: {
      minify: "esbuild",
      rollupOptions: {
        // App builds drop entry exports, which would bundle (and measure)
        // nothing at all. Keep the signature so the import graph is real.
        preserveEntrySignatures: "strict",
        external: [
          /^@pracht\//,
          "@standard-schema/spec",
          "preact",
          /^preact\//,
          "preact-render-to-string",
          // The streaming renderer is a subpath import (`/stream`), so the
          // bare specifier alone does not externalize it.
          /^preact-render-to-string\//,
        ],
        input: publicId,
      },
      write: false,
    },
  });

  if ("on" in result) throw new Error("Unexpected Vite watcher result");
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk");

  return {
    code: chunks.map((chunk) => chunk.code).join("\n"),
    gzipBytes: chunks.reduce(
      (total, chunk) => total + gzipSync(Buffer.from(chunk.code)).byteLength,
      0,
    ),
    warnings,
  };
}

describe("published package tree shaking", () => {
  it("keeps prerender initialization while marking other modules as side-effect-free", () => {
    expect(packageJson.sideEffects).toEqual(["./dist/prerender.mjs"]);
  });

  it("requires a renderer version that exports the streaming entry point", () => {
    expect(packageJson.peerDependencies?.["preact-render-to-string"]).toBe("^6.5.0");
  });

  it("emits source modules instead of shared cross-entry chunks", () => {
    expect(readFileSync(browserEntry, "utf-8")).toContain('from "./href.mjs"');
    expect(readFileSync(join(outputDir, "href.mjs"), "utf-8")).toContain("createHref");
  });

  it.each([
    ["publicEnv", 350],
    // Public deploy-base helpers add one tiny re-export to the browser entry.
    ["createHref", 1_410],
    ["apiFetch", 2_200],
    ["PrachtHttpError", 350],
    // Standalone cost incl. the useIsHydrated machinery; in a hydrating app
    // most of that is already present, so the marginal cost is lower.
    ["Script", 2_400],
  ])("keeps a named %s import below %i gzip bytes", async (exportName, maxGzipBytes) => {
    expect((await bundleExport(exportName)).gzipBytes).toBeLessThanOrEqual(maxGzipBytes);
  });

  // The generated client entry (`@pracht/core/client`) is what every hydrating
  // app loads, so anything reachable from it is unconditional. Two features
  // used to be: Suspense hydration tracking and capability revalidation. Both
  // now hang off the code that actually uses them.
  describe("client entry", () => {
    // Measure a production-shaped build: the dev-only hydration mismatch
    // warning (and the Suspense chain it needs) is dead code in a real app
    // bundle, so counting it would hide what ships.
    const production = { define: { "import.meta.env.DEV": "false" }, entry: clientEntry };

    // A ceiling, not a target: every byte here is on the critical path of
    // every hydrating route. Lower it when a feature moves off that path;
    // raising it should need a reason.
    it("keeps the router runtime below 9,600 gzip bytes", async () => {
      const { gzipBytes } = await bundleExport("initClientRouter", production);

      expect(gzipBytes).toBeLessThanOrEqual(9_600);
    });

    it("drops compat Suspense when the app renders no Suspense boundary", async () => {
      const { code } = await bundleExport("initClientRouter", production);

      expect(code).not.toContain("preact/compat");
    });

    it("drops capability revalidation when the app dispatches no capability calls", async () => {
      const { code } = await bundleExport("initClientRouter", production);

      expect(code).not.toContain("@pracht/capabilities");
    });

    it("keeps Suspense hydration tracking reachable from the Suspense export", async () => {
      const { code } = await bundleExport("Suspense");

      expect(code).toContain("preact/compat");
    });

    it("keeps capability revalidation reachable from the dispatch paths", async () => {
      const { code } = await bundleExport("ensureCapabilityRevalidation");

      expect(code).toContain("@pracht/capabilities");
    });
  });

  // `pracht({ client: { prefetch: false } })` compiles the prefetch runtime out
  // of the client bundle. The router reaches it directly, so only the define
  // can remove it.
  describe("__PRACHT_CLIENT_PREFETCH__", () => {
    // Production shape: the dev-only hydration mismatch warning is dead code in
    // a real app bundle, so counting it would hide what ships.
    const PRODUCTION = { "import.meta.env.DEV": "false" };

    const routerBundle = (define: Record<string, string>) =>
      bundleExport("initClientRouter", {
        define: { ...PRODUCTION, ...define },
        entry: clientEntry,
      });

    it("drops the prefetch runtime, including its lazily imported chunk", async () => {
      const { code } = await routerBundle({ __PRACHT_CLIENT_PREFETCH__: "false" });

      // `setupPrefetching` lives behind a dynamic import. Rollup only drops the
      // chunk when the import expression itself is proven dead, so an assertion
      // on the entry chunk alone would pass while the chunk still shipped.
      expect(code).not.toContain("setupPrefetching");
      expect(code).not.toContain("data-pracht-prefetch");
    });

    it("cuts the router runtime by at least a fifth", async () => {
      const on = await routerBundle({ __PRACHT_CLIENT_PREFETCH__: "true" });
      const off = await routerBundle({ __PRACHT_CLIENT_PREFETCH__: "false" });

      expect(off.gzipBytes).toBeLessThanOrEqual(on.gzipBytes * 0.8);
    });

    it("keeps prefetching when the feature is enabled", async () => {
      const { code } = await routerBundle({ __PRACHT_CLIENT_PREFETCH__: "true" });

      expect(code).toContain("setupPrefetching");
    });

    it("costs nothing when the define is absent", async () => {
      // Unit tests and direct Node imports run without the define. The `typeof`
      // guard has to keep prefetching on rather than throw.
      const { code } = await routerBundle({});

      expect(code).toContain("setupPrefetching");
    });
  });

  // The agent surface is opt-in: a server bundle for an app that registers no
  // capabilities and configures no agents must not contain the capability
  // dispatch or the Web Bot Auth verifier at all.
  describe("__PRACHT_AGENT_SURFACE__", () => {
    it("keeps graph serialization from defeating lazy agent-runtime chunks", async () => {
      const { warnings } = await bundleExport("buildAppGraph, buildLlmsTxt, handlePrachtRequest", {
        entry: serverEntry,
      });

      expect(warnings.filter((warning) => warning.includes("INEFFECTIVE_DYNAMIC_IMPORT"))).toEqual(
        [],
      );
    });

    it("drops the capability and agent-trust runtimes when the build proves they are unused", async () => {
      // Bundle the same two framework surfaces a generated server with
      // `llmsTxt` enabled imports. Build-time discovery must not retain the
      // request-time capability runtime when the manifest proves it is empty.
      const { code, gzipBytes } = await bundleExport("buildLlmsTxt, handlePrachtRequest", {
        entry: serverEntry,
        define: { __PRACHT_AGENT_SURFACE__: "false" },
      });

      expect(code).not.toContain("web-bot-auth");
      expect(code).not.toContain("/api/capabilities");
      expect(code).not.toContain("unknown_capability");
      expect(gzipBytes).toBeLessThanOrEqual(
        (await bundleExport("handlePrachtRequest", { entry: serverEntry })).gzipBytes,
      );
    });

    it("keeps them reachable when the build cannot prove it", async () => {
      const { code } = await bundleExport("handlePrachtRequest", { entry: serverEntry });

      expect(code).toContain("web-bot-auth");
      expect(code).toContain("unknown_capability");
    });
  });
});
