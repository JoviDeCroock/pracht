import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { build, createLogger } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const frameworkRoot = fileURLToPath(new URL("..", import.meta.url));
const capabilitiesDist = fileURLToPath(new URL("../../capabilities/dist/", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "pracht-tree-shaking-"));
const outputDir = join(tempRoot, "dist");
const browserEntry = join(outputDir, "browser.mjs");
const clientEntry = join(outputDir, "client.mjs");
const serverEntry = join(outputDir, "server.mjs");

type FrameworkPackage = {
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
): Promise<{
  code: string;
  /** The entry chunk alone — what a page pays before any lazy chunk loads. */
  entryCode: string;
  entryGzipBytes: number;
  gzipBytes: number;
  warnings: string[];
}> {
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
    resolve: {
      // Bundle @pracht/capabilities for real: the capability/agent runtime
      // lives there now, and the whole point of the agent-surface assertions
      // is to measure whether those bytes ship. The workspace package resolves
      // through its dist files so its package.json `sideEffects: false` is in
      // force, exactly as in an app build.
      alias: [
        {
          find: "@pracht/capabilities/server/internal",
          replacement: join(capabilitiesDist, "server-internal.mjs"),
        },
        { find: "@pracht/capabilities/server", replacement: join(capabilitiesDist, "server.mjs") },
        { find: "@pracht/capabilities/static", replacement: join(capabilitiesDist, "static.mjs") },
        { find: "@pracht/capabilities/webmcp", replacement: join(capabilitiesDist, "webmcp.mjs") },
        { find: "@pracht/capabilities", replacement: join(capabilitiesDist, "index.mjs") },
      ],
    },
    build: {
      minify: "esbuild",
      rollupOptions: {
        // App builds drop entry exports, which would bundle (and measure)
        // nothing at all. Keep the signature so the import graph is real.
        preserveEntrySignatures: "strict",
        external: [
          /^@pracht\/(?!capabilities)/,
          "@standard-schema/spec",
          "preact",
          /^preact\//,
          "preact-render-to-string",
          "preact-suspense",
        ],
        input: publicId,
      },
      write: false,
    },
  });

  if ("on" in result) throw new Error("Unexpected Vite watcher result");
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk");

  const entryChunks = chunks.filter((chunk) => chunk.isEntry);

  return {
    code: chunks.map((chunk) => chunk.code).join("\n"),
    entryCode: entryChunks.map((chunk) => chunk.code).join("\n"),
    entryGzipBytes: entryChunks.reduce(
      (total, chunk) => total + gzipSync(Buffer.from(chunk.code)).byteLength,
      0,
    ),
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

  it("emits source modules instead of shared cross-entry chunks", () => {
    expect(readFileSync(browserEntry, "utf-8")).toContain('from "./href.mjs"');
    expect(readFileSync(join(outputDir, "href.mjs"), "utf-8")).toContain("createHref");
  });

  it.each([
    ["publicEnv", 350],
    // Public deploy-base helpers add one tiny re-export to the browser entry.
    // Was 1,410 while @pracht/capabilities sat on the external list; bundling
    // it (which the agent-surface assertions need) measures 1,421 under
    // vitest's bundler — reproducibly, and with zero capability-code markers
    // in the output — so the budget carries matching headroom. Standalone
    // vite measures this same graph smaller; trust the number the harness
    // that runs in CI produces.
    ["createHref", 1_440],
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
    //
    // Raised from 9,600 for `useBlocker()` navigation guards. Two thirds of
    // that is not the guard checks but the per-history-entry index the router
    // has to stamp on every entry it creates so a refused back/forward
    // traversal can be put back — unconditional, because a guard mounted later
    // still has to measure traversals across entries created earlier. An app
    // that never guards a navigation compiles all of it out with
    // `client: { navigationGuards: false }`, which lands below the old ceiling.
    //
    // No app built through the plugin measures at this number: the plugin
    // always emits the define, so a real bundle is smaller either way. This
    // shape (no client defines at all) is the worst case, where neither branch
    // can be folded.
    //
    // Raised from 9,850 for the bounded redirect chain: a loader redirect the
    // client follows now carries a hop count, and an opaque redirect (whose
    // destination the browser refuses to expose) falls back to a document
    // navigation instead of re-fetching the URL it just asked for.
    // Raised from 9,900 for the route-commit projection hook that swaps
    // page-scoped WebMCP tools after navigation.
    it("keeps the router runtime below 9,950 gzip bytes", async () => {
      const { gzipBytes } = await bundleExport("initClientRouter", production);

      expect(gzipBytes).toBeLessThanOrEqual(9_950);
    });

    it("drops preact-suspense when the app renders no Suspense boundary", async () => {
      const { code } = await bundleExport("initClientRouter", production);

      expect(code).not.toContain("preact-suspense");
    });

    it("drops the navigation blocker when the app renders no useBlocker()", async () => {
      const { code } = await bundleExport("initClientRouter", production);

      // The router reads a window slot instead of importing the guard store,
      // so the `beforeunload` wiring and subscriber set only ship when
      // `useBlocker()` puts them there.
      expect(code).not.toContain("beforeunload");
    });

    it("drops capability revalidation when the app dispatches no capability calls", async () => {
      const { code } = await bundleExport("initClientRouter", production);

      // @pracht/capabilities is bundled by this harness, so assert on the
      // settled-event wire constant rather than the import specifier.
      expect(code).not.toContain("pracht:capability-settled");
    });

    it("keeps Suspense hydration tracking reachable from the Suspense export", async () => {
      const { code } = await bundleExport("Suspense");

      expect(code).toContain("preact-suspense");
    });

    it("keeps capability revalidation reachable from the dispatch paths", async () => {
      const { code } = await bundleExport("ensureCapabilityRevalidation");

      expect(code).toContain("pracht:capability-settled");
    });
  });

  // `<Form>` is the one client export that can dispatch a capability call, and
  // it used to pay for that on every page that rendered a plain
  // `<Form action=…>`: the revalidation listener was imported at module scope.
  describe("<Form> in an app with no capabilities", () => {
    const production = { define: { "import.meta.env.DEV": "false" } };

    it("keeps the capability revalidation runtime out of the entry chunk", async () => {
      const { entryCode } = await bundleExport("Form", production);

      // The listener and everything it reaches — route-state re-fetching,
      // error deserialization, font reapplication — now sit behind the
      // dynamic import in the `capability` branch.
      expect(entryCode).not.toContain("shouldRevalidateAfterCapability");
      expect(entryCode).not.toContain("revalidateRouteData");
      expect(entryCode).not.toContain("pracht:capability-settled");
    });

    it("keeps only the wire-protocol constants of @pracht/capabilities", async () => {
      const { entryCode } = await bundleExport("Form", production);

      // Rendering the form element needs the capability URL formula and the
      // enhanced-submission header names; nothing else from the package may
      // ride along.
      expect(entryCode).not.toContain("defineCapability");
      expect(entryCode).not.toContain("invalid_input");
    });

    // Was 3,539 when the listener was imported at module scope. The lazy
    // chunk is bigger than the bytes it saves in isolation, but a page only
    // fetches it after a capability form is submitted.
    it("stays under 2,750 gzip bytes in the entry chunk", async () => {
      const { entryGzipBytes } = await bundleExport("Form", production);

      expect(entryGzipBytes).toBeLessThanOrEqual(2_750);
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
  describe("__PRACHT_CLIENT_BLOCKER__", () => {
    const PRODUCTION = { "import.meta.env.DEV": "false" };

    const routerBundle = (define: Record<string, string>) =>
      bundleExport("initClientRouter", {
        define: { ...PRODUCTION, ...define },
        entry: clientEntry,
      });

    it("drops the guard checks and the history-entry index when disabled", async () => {
      const { code } = await routerBundle({ __PRACHT_CLIENT_BLOCKER__: "false" });

      expect(code).not.toContain("__PRACHT_BLOCK_NAVIGATION__");
      expect(code).not.toContain("__prachtHistoryIndex");
    });

    it("lands below the pre-guard ceiling when disabled", async () => {
      // The point of the switch: an app that guards no navigation pays nothing
      // for the feature, including the index stamped on every history entry.
      const { gzipBytes } = await routerBundle({ __PRACHT_CLIENT_BLOCKER__: "false" });

      expect(gzipBytes).toBeLessThanOrEqual(9_670);
    });

    it("keeps guards when the feature is enabled", async () => {
      const { code } = await routerBundle({ __PRACHT_CLIENT_BLOCKER__: "true" });

      expect(code).toContain("__PRACHT_BLOCK_NAVIGATION__");
      expect(code).toContain("__prachtHistoryIndex");
    });

    it("costs nothing when the define is absent", async () => {
      // Unit tests and direct Node imports run without the define. The `typeof`
      // guard has to keep guards on rather than throw.
      const { code } = await routerBundle({});

      expect(code).toContain("__PRACHT_BLOCK_NAVIGATION__");
    });
  });

  // `src/routes.ts` is the one module both environments compile, so a check
  // written next to the option in `defineApp()` is paid for by every page.
  // Only the server reads `loaderTimeoutMs`, so that is where the check that
  // always runs lives — a bad value reaching production must still fail loudly
  // rather than turning into `AbortSignal.timeout(NaN)`.
  describe("loaderTimeoutMs validation", () => {
    const production = { define: { "import.meta.env.DEV": "false" } };

    it("survives on the server after dev-only manifest validation folds out", async () => {
      const { code } = await bundleExport("handlePrachtRequest", {
        ...production,
        entry: serverEntry,
      });

      expect(code).toContain("must be a positive number of milliseconds");
    });

    it("costs a production client bundle nothing", async () => {
      const { code } = await bundleExport("defineApp", production);

      // The manifest still carries the value through to the server; what must
      // not ship is the check and the sentence explaining it.
      expect(code).not.toContain("positive number of milliseconds");
      expect(code).not.toContain("isFinite");
    });

    it("drops the rest of the manifest validation from the client too", async () => {
      const { code } = await bundleExport("defineApp", production);

      expect(code).not.toContain("is not a registered");
    });
  });

  // The package resolves to a different entry in the browser than on the
  // server, so it has to resolve to different *types* there too. A single
  // unconditional `types` handed client code ~70 server-only declarations
  // that type-check and then fail at bundle time.
  describe("browser export condition", () => {
    /** Minimal conditional-exports walk: first matching condition wins. */
    function resolveExport(entry: unknown, conditions: string[]): string | undefined {
      if (typeof entry === "string") return entry;
      if (entry === null || typeof entry !== "object") return undefined;
      for (const [condition, value] of Object.entries(entry as Record<string, unknown>)) {
        if (condition === "default" || conditions.includes(condition)) {
          const resolved = resolveExport(value, conditions);
          if (resolved) return resolved;
        }
      }
      return undefined;
    }

    const rootExport = (
      JSON.parse(readFileSync(join(frameworkRoot, "package.json"), "utf-8")) as {
        exports: Record<string, unknown>;
      }
    ).exports["."];

    it("resolves types and runtime to the same entry under every condition", () => {
      expect(resolveExport(rootExport, ["browser", "types"])).toBe("./dist/browser.d.mts");
      expect(resolveExport(rootExport, ["browser", "import"])).toBe("./dist/browser.mjs");
      expect(resolveExport(rootExport, ["types"])).toBe("./dist/index.d.mts");
      expect(resolveExport(rootExport, ["import"])).toBe("./dist/index.mjs");
    });

    it("does not declare server-only exports in the browser types", () => {
      const browserTypes = readFileSync(join(outputDir, "browser.d.mts"), "utf-8");
      const indexTypes = readFileSync(join(outputDir, "index.d.mts"), "utf-8");

      for (const serverOnly of ["handlePrachtRequest", "prerenderApp", "handleMcpRequest"]) {
        expect(indexTypes).toContain(serverOnly);
        expect(browserTypes).not.toContain(serverOnly);
      }
    });

    it("declares the pure route and constraint helpers client code needs", () => {
      const browserTypes = readFileSync(join(outputDir, "browser.d.mts"), "utf-8");

      for (const helper of [
        "evaluateConstraints",
        "matchApiRoute",
        "matchRoutePath",
        "resolveApiRoutes",
        "routePathIsDynamic",
      ]) {
        expect(browserTypes).toContain(helper);
      }
    });

    it("exports those helpers at runtime as well as in the types", async () => {
      const browser = (await import("../src/browser.ts")) as Record<string, unknown>;

      for (const helper of [
        "evaluateConstraints",
        "matchApiRoute",
        "matchRoutePath",
        "resolveApiRoutes",
        "routePathIsDynamic",
      ]) {
        expect(typeof browser[helper]).toBe("function");
      }
    });
  });

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
      expect(code).not.toContain("signature-input");
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
