import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { PRACHT_CLIENT_MODULE_ID, PRACHT_ISLANDS_CLIENT_MODULE_ID } from "../src/plugin-assets.ts";
import { createPreactPlugins } from "../src/preact-plugins.ts";

function plugin(name: string): Plugin {
  const found = createPreactPlugins().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing plugin ${name}`);
  return found;
}

function config(command: "serve" | "build") {
  const hook = plugin("pracht:preact").config as (config: object, env: object) => any;
  return hook.call({}, {}, { command, mode: command === "serve" ? "development" : "production" });
}

function devtoolsTransform(code: string, id: string, ssr = false) {
  const transform = plugin("pracht:preact-devtools").transform as {
    filter: { id: RegExp };
    handler: (code: string, id: string, options?: { ssr?: boolean }) => unknown;
  };
  if (!transform.filter.id.test(id)) return null;
  return transform.handler.call({}, code, id, { ssr });
}

describe("createPreactPlugins", () => {
  it("compiles JSX with Preact's automatic runtime through Oxc", () => {
    const resolved = config("build");
    expect(resolved.oxc).toEqual({ jsx: { runtime: "automatic", importSource: "preact" } });
    expect(resolved.optimizeDeps.rolldownOptions).toEqual({
      transform: { jsx: { runtime: "automatic" } },
    });
  });

  it("resolves React packages to preact/compat", () => {
    expect(config("build").resolve.alias).toEqual({
      "react-dom/test-utils": "preact/test-utils",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      react: "preact/compat",
    });
  });

  it("pre-bundles preact/devtools only for the dev server", () => {
    expect(config("serve").optimizeDeps.include).toContain("preact/devtools");
    expect(config("build").optimizeDeps.include).not.toContain("preact/devtools");
  });

  it("connects Preact DevTools from both client entries in dev", () => {
    expect(plugin("pracht:preact-devtools").apply).toBe("serve");
    for (const id of [PRACHT_CLIENT_MODULE_ID, PRACHT_ISLANDS_CLIENT_MODULE_ID]) {
      expect(devtoolsTransform("entry();", id)).toEqual({
        code: 'import "preact/devtools";\nentry();',
        map: null,
      });
    }
  });

  it("leaves server transforms and other modules alone", () => {
    expect(devtoolsTransform("entry();", PRACHT_CLIENT_MODULE_ID, true)).toBeNull();
    expect(devtoolsTransform("x();", "/app/src/routes/home.tsx")).toBeNull();
    expect(devtoolsTransform("x();", "virtual:pracht/server-islands-client")).toBeNull();
  });

  it("includes prefresh for Fast Refresh", () => {
    expect(createPreactPlugins().map((candidate) => candidate.name)).toContain("prefresh");
  });
});
