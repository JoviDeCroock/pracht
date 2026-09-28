import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPrachtRegistryModuleSource } from "../src/index.ts";
import { createPrachtClientModuleSource } from "../src/plugin-codegen.ts";
import { findAppRootModule } from "../src/plugin-app-root.ts";

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-app-root-"));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
}

function manifest(appConfig: string): string {
  return [
    'import { defineApp, route } from "@pracht/core";',
    "export const app = defineApp({",
    appConfig,
    '  routes: [route("/", () => import("./routes/home.tsx"))],',
    "});",
  ].join("\n");
}

const ROOT_SOURCE = "export function setup() { return {}; }\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("app root codegen", () => {
  it("bundles the module defineApp({ root }) registers, on both sides", () => {
    const root = project({
      "src/routes.ts": manifest('  root: () => import("./app/root.tsx"),'),
      "src/app/root.tsx": ROOT_SOURCE,
    });

    expect(createPrachtRegistryModuleSource({}, { root })).toContain(
      'export const rootModules = { "/src/app/root.tsx": () => import("/src/app/root.tsx") };',
    );
    const client = createPrachtClientModuleSource({}, { root });
    expect(client).toContain('import * as rootModule from "/src/app/root.tsx";');
    expect(client).toContain("    rootModule,");
  });

  it("accepts a string path, like a shell ref", () => {
    const root = project({
      "src/routes.ts": manifest('  root: "./root.tsx",'),
      "src/root.tsx": ROOT_SOURCE,
    });

    expect(findAppRootModule({}, root)).toEqual({ ref: "./root.tsx", id: "/src/root.tsx" });
  });

  it("ignores a src/root.tsx the manifest does not register", () => {
    const root = project({
      "src/routes.ts": manifest(""),
      "src/root.tsx": "export function Root() { return null; }\n",
    });

    expect(findAppRootModule({}, root)).toBeNull();
    expect(createPrachtRegistryModuleSource({}, { root })).toContain(
      "export const rootModules = {};",
    );
    expect(createPrachtClientModuleSource({}, { root })).not.toContain("rootModule");
  });

  it("refuses a root the build cannot read or find", () => {
    const variable = project({
      "src/routes.ts": `const ref = "./root.tsx";\n${manifest("  root: ref,")}`,
      "src/root.tsx": ROOT_SOURCE,
    });
    expect(() => findAppRootModule({}, variable)).toThrow(/must be a string path/);

    const shorthand = project({
      "src/routes.ts": `const root = "./root.tsx";\n${manifest("  root,")}`,
    });
    expect(() => findAppRootModule({}, shorthand)).toThrow(/must be a string path/);

    const missing = project({ "src/routes.ts": manifest('  root: "./root.tsx",') });
    expect(() => findAppRootModule({}, missing)).toThrow(/does not exist/);
  });

  it("registers a pages-root _root file in pages mode", () => {
    const root = project({
      "src/pages/index.tsx": "export default function Home() { return null; }\n",
      "src/pages/_root.tsx": ROOT_SOURCE,
    });

    expect(findAppRootModule({ pagesDir: "/src/pages" }, root)).toEqual({
      ref: "/src/pages/_root.tsx",
      id: "/src/pages/_root.tsx",
    });
  });
});
