import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build, type Rollup } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { findPagesCapabilityFiles, scanPagesDirectory } from "../src/pages-router.ts";
import {
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtRegistryModuleSource,
} from "../src/plugin-codegen.ts";
import { createRouteLoaderHints } from "../src/route-loader-hints.ts";
import { isNonModuleFile } from "../src/source-files.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-non-module-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const MODULE = 'export default function Module() { return "APP_MODULE"; }\n';
// A colocated test that would run its suite, and ship its runner, if pracht
// ever imported it.
const TEST = `import { test } from "node:test";
test("runs", () => {});
export function GET() { return new Response("TEST_FILE_MARKER"); }
export default function TestFile() { return "TEST_FILE_MARKER"; }
`;

/** Every module key the generated sources' `import.meta.glob` calls resolve to on disk. */
async function resolvedGlobKeys(root: string, sources: Record<string, string>): Promise<string> {
  const output = (await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "non-module-files-test",
        resolveId: (id) => (id in sources ? `\0${id}` : null),
        load: (id) => (id.startsWith("\0") ? sources[id.slice(1)] : null),
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: Object.keys(sources),
        // Keep every registry export so all of its globs reach the output.
        preserveEntrySignatures: "strict",
        external: (id) => /^(?:@pracht\/|node:|virtual:pracht\/)/.test(id),
      },
    },
  })) as Rollup.RollupOutput;
  return output.output
    .map((chunk) => (chunk.type === "chunk" ? `${chunk.fileName}\n${chunk.code}` : chunk.fileName))
    .join("\n");
}

describe("isNonModuleFile", () => {
  it.each([
    "health.test.ts",
    "health.spec.tsx",
    "Counter.test.jsx",
    "types.d.ts",
    "__tests__/helpers.ts",
    "users/__tests__/[id].ts",
    "__mocks__/db.ts",
  ])("treats %s as a non-module", (path) => {
    expect(isNonModuleFile(path)).toBe(true);
  });

  it.each(["health.ts", "latest.tsx", "contest.ts", "spec.ts", "test.tsx", "users/[id].ts"])(
    "treats %s as a module",
    (path) => {
      expect(isNonModuleFile(path)).toBe(false);
    },
  );
});

describe("colocated tests and mocks", () => {
  it("are never discovered as manifest-mode routes, API routes, middleware, or islands", async () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home" })],
});
`,
      "src/routes/home.tsx": MODULE,
      "src/routes/home.test.tsx": TEST,
      "src/routes/__tests__/home.tsx": TEST,
      "src/shells/main.tsx": MODULE,
      "src/shells/main.spec.tsx": TEST,
      "src/api/health.ts": MODULE,
      "src/api/health.test.ts": TEST,
      "src/api/health.spec.ts": TEST,
      "src/api/__tests__/helpers.ts": TEST,
      "src/api/__mocks__/db.ts": TEST,
      "src/middleware/auth.ts": MODULE,
      "src/middleware/auth.test.ts": TEST,
      "src/server/db.ts": MODULE,
      "src/server/db.test.ts": TEST,
      "src/capabilities/search.ts": MODULE,
      "src/capabilities/search.test.ts": TEST,
      "src/islands/Counter.tsx": MODULE,
      "src/islands/Counter.test.tsx": TEST,
    });
    const options = { appFile: "/src/routes.ts" };

    const output = await resolvedGlobKeys(root, {
      "registry-entry": createPrachtRegistryModuleSource(options),
      "client-entry": createPrachtClientModuleSource(options, { root }),
      "islands-entry": createPrachtIslandsClientModuleSource(options, { root }),
    });

    for (const module of [
      "/src/routes/home.tsx",
      "/src/shells/main.tsx",
      "/src/api/health.ts",
      "/src/middleware/auth.ts",
      "/src/server/db.ts",
      "/src/capabilities/search.ts",
      "/src/islands/Counter.tsx",
    ]) {
      expect(output).toContain(JSON.stringify(module));
    }
    expect(output).not.toContain("TEST_FILE_MARKER");
    expect(output).not.toMatch(/\.(?:test|spec)\b|__tests__|__mocks__/);
  });

  it("are never discovered as pages, pages middleware helpers, or pages capabilities", async () => {
    const root = project({
      "src/pages/index.tsx": MODULE,
      "src/pages/index.test.tsx": TEST,
      "src/pages/blog/post.spec.tsx": TEST,
      "src/pages/__tests__/about.tsx": TEST,
      "src/capabilities/search.ts":
        'export default { name: "search", run() { return "APP_MODULE"; } };\n',
      "src/capabilities/search.test.ts": TEST,
      "src/capabilities/__tests__/other.ts": TEST,
    });

    expect(scanPagesDirectory(join(root, "src/pages")).map((page) => page.routePath)).toEqual([
      "/",
    ]);
    expect(findPagesCapabilityFiles(join(root, "src/capabilities")).map((c) => c.name)).toEqual([
      "search",
    ]);

    const options = { pagesDir: "/src/pages" };
    const output = await resolvedGlobKeys(root, {
      "registry-entry": createPrachtRegistryModuleSource(options),
      "client-entry": createPrachtClientModuleSource(options, { root }),
    });
    expect(output).toContain('"/src/pages/index.tsx"');
    expect(output).not.toContain("TEST_FILE_MARKER");
  });

  it("contribute no route loader hints", () => {
    const root = project({
      "src/routes/home.tsx": "export async function loader() {}\n" + MODULE,
      "src/routes/home.test.tsx": "export async function loader() {}\n" + TEST,
      "src/routes/__mocks__/data.tsx": "export async function loader() {}\n",
    });

    expect(
      Object.keys(
        createRouteLoaderHints(join(root, "src/routes"), { rootRelativePrefix: "/src/routes" }),
      ),
    ).toEqual(["/src/routes/home.tsx"]);
  });
});
