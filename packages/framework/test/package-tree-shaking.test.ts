import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const frameworkRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "pracht-tree-shaking-"));
const outputDir = join(tempRoot, "dist");
const browserEntry = join(outputDir, "browser.mjs");

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

async function bundleExport(exportName: string): Promise<number> {
  const publicId = "virtual:pracht-tree-shaking-entry";
  const resolvedId = `\0${publicId}`;
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: {
      __PRACHT_PUBLIC_ENV__: "{}",
    },
    plugins: [
      {
        name: "pracht-tree-shaking-test",
        resolveId(id) {
          if (id === publicId) return resolvedId;
        },
        load(id) {
          if (id !== resolvedId) return;
          return `export { ${exportName} } from ${JSON.stringify(pathToFileURL(browserEntry).href)};`;
        },
      },
    ],
    build: {
      minify: "esbuild",
      rollupOptions: {
        external: [/^@pracht\//, "@standard-schema/spec", "preact", /^preact\//, "preact-suspense"],
        input: publicId,
      },
      write: false,
    },
  });

  if ("on" in result) throw new Error("Unexpected Vite watcher result");
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((output) => output.output)
    .filter((item) => item.type === "chunk")
    .reduce((total, chunk) => total + gzipSync(Buffer.from(chunk.code)).byteLength, 0);
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
    ["createHref", 1_400],
    ["apiFetch", 2_200],
    ["PrachtHttpError", 350],
  ])("keeps a named %s import below %i gzip bytes", async (exportName, maxGzipBytes) => {
    expect(await bundleExport(exportName)).toBeLessThanOrEqual(maxGzipBytes);
  });
});
