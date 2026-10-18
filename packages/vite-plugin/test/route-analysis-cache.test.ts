import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const {
  collectManifestModuleRefs,
  createPrachtClientModuleSource,
  createRouteHintsForVirtualModules,
} = await import("../src/plugin-codegen.ts");
const { resolveOptions } = await import("../src/plugin-options.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  vi.mocked(fs.readFileSync).mockClear();
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(join(tmpdir(), "pracht-analysis-cache-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(root, name)), { recursive: true });
    fs.writeFileSync(join(root, name), content);
  }
  return root;
}

function readsOf(path: string): number {
  return vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => String(file).endsWith(path))
    .length;
}

const MANIFEST = `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ routes: [route("/", "./routes/home.tsx", { id: "home" })] });
`;

describe("per-file analysis cache", () => {
  it("parses an unchanged route module once across regenerations", () => {
    const root = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": "export function Component() { return null; }\n",
      "src/routes/about.tsx": "export function Component() { return null; }\n",
    });
    const options = resolveOptions({});

    for (let i = 0; i < 4; i++) createRouteHintsForVirtualModules(options, root);
    expect(readsOf("/src/routes/home.tsx")).toBe(1);
    expect(readsOf("/src/routes/about.tsx")).toBe(1);
  });

  it("re-reads a module whose file changed, and only that one", () => {
    const root = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": "export function Component() { return null; }\n",
      "src/routes/about.tsx": "export function Component() { return null; }\n",
    });
    const options = resolveOptions({});
    expect(createRouteHintsForVirtualModules(options, root).loader["/src/routes/home.tsx"]).toBe(
      false,
    );

    fs.writeFileSync(
      join(root, "src/routes/home.tsx"),
      "export async function loader() { return {}; }\nexport function Component() { return null; }\n",
    );
    expect(createRouteHintsForVirtualModules(options, root).loader["/src/routes/home.tsx"]).toBe(
      true,
    );
    expect(readsOf("/src/routes/home.tsx")).toBe(2);
    expect(readsOf("/src/routes/about.tsx")).toBe(1);
  });

  it("parses an unchanged page once across pages-router regenerations", () => {
    const root = project({
      "src/pages/index.tsx": "export function Component() { return null; }\n",
      "src/pages/about.tsx": "export function Component() { return null; }\n",
    });
    const options = resolveOptions({ pagesDir: "/src/pages" });

    for (let i = 0; i < 3; i++) {
      createRouteHintsForVirtualModules(options, root);
      createPrachtClientModuleSource({ pagesDir: "/src/pages" }, { root });
    }
    const before = readsOf("/src/pages/about.tsx");
    for (let i = 0; i < 3; i++) {
      createRouteHintsForVirtualModules(options, root);
      createPrachtClientModuleSource({ pagesDir: "/src/pages" }, { root });
    }
    expect(readsOf("/src/pages/about.tsx")).toBe(before);

    fs.writeFileSync(
      join(root, "src/pages/about.tsx"),
      "export async function loader() { return {}; }\nexport function Component() { return null; }\n",
    );
    expect(createRouteHintsForVirtualModules(options, root).loader["/src/pages/about.tsx"]).toBe(
      true,
    );
  });

  it("parses an unchanged manifest module once and sees an edit to it", () => {
    const root = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": "export function Component() { return null; }\n",
      "src/routes/draft.tsx": "export function Component() { return null; }\n",
    });
    const options = resolveOptions({});

    for (let i = 0; i < 3; i++) collectManifestModuleRefs(options, root);
    expect(readsOf("/src/routes.ts")).toBe(1);
    expect(
      [...collectManifestModuleRefs(options, root).files].some((f) => f.endsWith("draft.tsx")),
    ).toBe(false);

    fs.writeFileSync(
      join(root, "src/routes.ts"),
      MANIFEST.replace('"home" })', '"home" }), route("/draft", "./routes/draft.tsx")'),
    );
    expect(
      [...collectManifestModuleRefs(options, root).files].some((f) => f.endsWith("draft.tsx")),
    ).toBe(true);
  });
});
