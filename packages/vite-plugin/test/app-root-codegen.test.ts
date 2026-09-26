import { describe, expect, it } from "vitest";

import { createPrachtRegistryModuleSource } from "../src/index.ts";
import { createPrachtClientModuleSource } from "../src/plugin-codegen.ts";

describe("app root codegen", () => {
  it("registers the root module for the server", () => {
    const source = createPrachtRegistryModuleSource({});
    expect(source).toContain(
      'export const rootModules = import.meta.glob("/src/root.{ts,tsx,js,jsx}");',
    );
    expect(source).toMatch(/export const registry = \{[^}]*rootModules,/);
  });

  it("loads the root eagerly in the client entry and hands it to the router", () => {
    const source = createPrachtClientModuleSource({});
    expect(source).toContain(
      'Object.values(import.meta.glob("/src/root.{ts,tsx,js,jsx}", { eager: true }))[0]',
    );
    expect(source).toContain(
      'const rootModule = typeof __PRACHT_APP_ROOT__ === "undefined" || __PRACHT_APP_ROOT__',
    );
    expect(source).toContain("...(rootModule ? { rootModule } : {}),");
  });

  it("follows a configured rootFile", () => {
    expect(createPrachtRegistryModuleSource({ rootFile: "/app/providers" })).toContain(
      'import.meta.glob("/app/providers.{ts,tsx,js,jsx}")',
    );
    expect(createPrachtClientModuleSource({ rootFile: "/app/providers" })).toContain(
      'import.meta.glob("/app/providers.{ts,tsx,js,jsx}", { eager: true })',
    );
  });
});
