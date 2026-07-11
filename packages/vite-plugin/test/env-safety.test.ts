import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { createEnvSafetyPlugin, scanCodeForEnvLeaks } from "../src/env-safety.ts";
import { pracht } from "../src/index.ts";

function getHook<T>(plugin: Plugin, name: keyof Plugin): T {
  const hook = plugin[name] as unknown as T | { handler: T };
  return typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
}

type TransformHook = (
  this: unknown,
  code: string,
  id: string,
  options?: { ssr?: boolean },
) => unknown;
type GenerateBundleHook = (this: unknown, options: unknown, bundle: unknown) => void;
type ConfigHook = (
  this: unknown,
  config: Record<string, unknown>,
  env: { command: string; mode: string; isSsrBuild?: boolean },
) => Record<string, unknown>;
type ResolveIdHook = (
  this: unknown,
  id: string,
  importer: string | undefined,
  options?: { ssr?: boolean; scan?: boolean },
) => unknown;

function chunk(fileName: string, code: string, moduleIds: string[] = []) {
  return { type: "chunk" as const, fileName, code, moduleIds };
}

function runGenerateBundle(
  plugin: Plugin,
  bundle: Record<string, unknown>,
  consumer: "client" | "server" = "client",
): unknown[] {
  const generateBundle = getHook<GenerateBundleHook>(plugin, "generateBundle");
  const emitted: unknown[] = [];
  generateBundle.call(
    {
      environment: { config: { consumer } },
      emitFile(file: unknown) {
        emitted.push(file);
        return "asset-ref";
      },
      error(message: string) {
        throw new Error(message);
      },
    },
    {},
    bundle,
  );
  return emitted;
}

describe("scanCodeForEnvLeaks", () => {
  it("flags non-public process.env and import.meta.env references", () => {
    const findings = scanCodeForEnvLeaks(
      `const a = process.env.SESSION_SECRET;
       const b = import.meta.env.API_TOKEN;
       const c = process.env["DATABASE_URL"];
       const d = import.meta.env['STRIPE_KEY'];`,
    );

    expect(findings).toEqual([
      { accessor: "process.env", name: "SESSION_SECRET" },
      { accessor: "import.meta.env", name: "API_TOKEN" },
      { accessor: "process.env", name: "DATABASE_URL" },
      { accessor: "import.meta.env", name: "STRIPE_KEY" },
    ]);
  });

  it("ignores public-prefixed vars, Vite built-ins, and NODE_ENV", () => {
    const findings = scanCodeForEnvLeaks(
      `const a = import.meta.env.PRACHT_PUBLIC_APP_NAME;
       const b = process.env.PRACHT_PUBLIC_API_BASE;
       const c = import.meta.env.VITE_LEGACY_PUBLIC_VALUE;
       const d = import.meta.env.MODE;
       const e = import.meta.env.DEV;
       const f = import.meta.env.PROD;
       const g = import.meta.env.SSR;
       const h = import.meta.env.BASE_URL;
       const i = process.env.NODE_ENV;`,
    );

    expect(findings).toEqual([]);
  });

  it("respects the allowlist and dedupes repeated references", () => {
    const code = `use(process.env.SENTRY_RELEASE, process.env.SENTRY_RELEASE, process.env.LEAKY);`;

    expect(scanCodeForEnvLeaks(code, new Set(["SENTRY_RELEASE"]))).toEqual([
      { accessor: "process.env", name: "LEAKY" },
    ]);
    expect(scanCodeForEnvLeaks(code)).toEqual([
      { accessor: "process.env", name: "SENTRY_RELEASE" },
      { accessor: "process.env", name: "LEAKY" },
    ]);
  });

  it("ignores comments and literal text while preserving real code references", () => {
    const findings = scanCodeForEnvLeaks(
      `
      // process.env.COMMENT_SECRET
      /* import.meta.env.BLOCK_SECRET */
      const message = "do not use process.env.STRING_SECRET";
      const single = 'import.meta.env.SINGLE_SECRET';
      const text = \`process.env.TEMPLATE_TEXT_SECRET\`;
      const pattern = /process.env.REGEX_SECRET/;
      const real = \`\${process.env.TEMPLATE_EXPR_SECRET}\`;
      const bracket = process.env["BRACKET_SECRET"];
      `,
    );

    expect(findings).toEqual([
      { accessor: "process.env", name: "TEMPLATE_EXPR_SECRET" },
      { accessor: "process.env", name: "BRACKET_SECRET" },
    ]);
  });
});

describe("createEnvSafetyPlugin", () => {
  it("fails client bundles naming the variable, chunk, and likely source module", () => {
    const plugin = createEnvSafetyPlugin({});
    const transform = getHook<TransformHook>(plugin, "transform");
    transform.call({}, "export const key = process.env.SECRET_KEY;", "/src/routes/leaky.tsx", {
      ssr: false,
    });

    expect(() =>
      runGenerateBundle(plugin, {
        "assets/index-abc123.js": chunk(
          "assets/index-abc123.js",
          "const key = process.env.SECRET_KEY;",
          ["/src/routes/leaky.tsx", "/src/routes/clean.tsx"],
        ),
      }),
    ).toThrowError(
      /process\.env\.SECRET_KEY in chunk "assets\/index-abc123\.js" \(likely from "\/src\/routes\/leaky\.tsx"\)/,
    );
  });

  it("catches references rewritten by the bundler via module attribution", () => {
    // rolldown rewrites `process.env.X` to `{}.X` in client output, so the
    // rendered chunk no longer contains the accessor text. The reference
    // recorded during transform must still fail the build.
    const plugin = createEnvSafetyPlugin({});
    const transform = getHook<TransformHook>(plugin, "transform");
    transform.call({}, "export const key = process.env.SECRET_KEY;", "/src/routes/leaky.tsx", {
      ssr: false,
    });
    // Dependency modules are not attributed — define-replaced references in
    // deps are safe after bundling.
    transform.call(
      {},
      "export const mode = process.env.SOME_DEP_VAR;",
      "/repo/node_modules/some-dep/index.js",
      { ssr: false },
    );

    expect(() =>
      runGenerateBundle(plugin, {
        "assets/index-abc123.js": chunk("assets/index-abc123.js", "const key = {}.SECRET_KEY;", [
          "/src/routes/leaky.tsx",
          "/repo/node_modules/some-dep/index.js",
        ]),
      }),
    ).toThrowError(/process\.env\.SECRET_KEY in chunk "assets\/index-abc123\.js".*leaky\.tsx/);

    const depOnly = createEnvSafetyPlugin({});
    const depTransform = getHook<TransformHook>(depOnly, "transform");
    depTransform.call(
      {},
      "export const mode = process.env.SOME_DEP_VAR;",
      "/repo/node_modules/some-dep/index.js",
      { ssr: false },
    );
    expect(() =>
      runGenerateBundle(depOnly, {
        "assets/vendor.js": chunk("assets/vendor.js", "const mode = {}.SOME_DEP_VAR;", [
          "/repo/node_modules/some-dep/index.js",
        ]),
      }),
    ).not.toThrow();
  });

  it("does not record modules transformed for SSR", () => {
    const plugin = createEnvSafetyPlugin({});
    const transform = getHook<TransformHook>(plugin, "transform");
    transform.call({}, "export const key = process.env.SECRET_KEY;", "/src/server/db.ts", {
      ssr: true,
    });

    expect(() =>
      runGenerateBundle(plugin, {
        "assets/index.js": chunk("assets/index.js", "const key = {}.SECRET_KEY;", [
          "/src/server/db.ts",
        ]),
      }),
    ).not.toThrow();
  });

  it("passes clean client bundles and skips server bundles", () => {
    const plugin = createEnvSafetyPlugin({});
    const cleanBundle = {
      "assets/index.js": chunk(
        "assets/index.js",
        "console.log(import.meta.env.PRACHT_PUBLIC_X, import.meta.env.VITE_PUBLIC_X);",
      ),
      "assets/style.css": { type: "asset" as const, fileName: "assets/style.css" },
    };
    const emitted = runGenerateBundle(plugin, cleanBundle);
    expect(emitted).toContainEqual({
      fileName: "_pracht/env-safety.json",
      source: JSON.stringify({ findings: [], version: 1 }, null, 2),
      type: "asset",
    });

    const serverBundle = {
      "server.js": chunk("server.js", "const url = process.env.DATABASE_URL;"),
    };
    expect(() => runGenerateBundle(plugin, serverBundle, "server")).not.toThrow();
  });

  it("honours the allow escape hatch and envSafety: false", () => {
    const allowing = createEnvSafetyPlugin({ allow: ["SENTRY_RELEASE"] });
    expect(() =>
      runGenerateBundle(allowing, {
        "assets/index.js": chunk("assets/index.js", "report(process.env.SENTRY_RELEASE);"),
      }),
    ).not.toThrow();

    const disabled = createEnvSafetyPlugin(false);
    expect(() =>
      runGenerateBundle(disabled, {
        "assets/index.js": chunk("assets/index.js", "leak(process.env.SESSION_SECRET);"),
      }),
    ).not.toThrow();
  });
});

describe("pracht plugin env wiring", () => {
  function findPlugin(name: string): Plugin {
    const plugin = pracht().find((candidate) => candidate.name === name);
    if (!plugin) throw new Error(`plugin ${name} not found`);
    return plugin;
  }

  it("adds PRACHT_PUBLIC_ to Vite's envPrefix alongside VITE_", () => {
    const plugin = findPlugin("pracht");
    const config = getHook<ConfigHook>(plugin, "config");
    const result = config.call({}, {}, { command: "build", mode: "production" });

    expect(result.envPrefix).toEqual(["VITE_", "PRACHT_PUBLIC_"]);
  });

  it("registers the env safety plugin", () => {
    expect(pracht().some((plugin) => plugin.name === "pracht:env-safety")).toBe(true);
    expect(
      pracht({ envSafety: { allow: ["SENTRY_RELEASE"] } }).some(
        (plugin) => plugin.name === "pracht:env-safety",
      ),
    ).toBe(true);
  });

  it("rejects client-side imports of @pracht/core/env/server", () => {
    const plugin = findPlugin("pracht");
    const resolveId = getHook<ResolveIdHook>(plugin, "resolveId");

    expect(() =>
      resolveId.call({}, "@pracht/core/env/server", "/src/components/widget.tsx", { ssr: false }),
    ).toThrowError(/server-only/);

    expect(
      resolveId.call({}, "@pracht/core/env/server", "/src/server/db.ts", { ssr: true }),
    ).toBeNull();
    expect(
      resolveId.call({}, "@pracht/core/env/server", "/src/routes/page.tsx", {
        ssr: false,
        scan: true,
      }),
    ).toBeNull();
  });
});
