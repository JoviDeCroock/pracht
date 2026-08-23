import { describe, expect, it } from "vitest";

import { ensureCoreNamedImport, insertArrayItem, upsertObjectEntry } from "../src/manifest.ts";
import { exportsMiddleware } from "../src/verification-checks.ts";

/** Parse the result so a syntax error cannot pass as "looks right". */
function expectParses(source: string): void {
  expect(() => new Function(source.replace(/^export\s+/gm, ""))).not.toThrow();
}

const NEW_ROUTE = 'route("/pricing", "./routes/pricing.tsx", {\n  id: "pricing",\n})';

describe("insertArrayItem", () => {
  it("puts the separating comma after the code, not inside a trailing comment", () => {
    // Appending at the last non-whitespace character wrote the comma into the
    // comment, leaving the two entries with no separator at all — a syntax
    // error that `pracht generate` reported as success.
    const source = [
      "const app = defineApp({",
      "  routes: [",
      '    route("/about", "./routes/about.tsx") // marketing page,',
      "  ],",
      "});",
      "",
    ].join("\n");

    const result = insertArrayItem(source, "routes", NEW_ROUTE);

    expect(result).toContain('route("/about", "./routes/about.tsx"), // marketing page,');
    expectParses(result.replace(/defineApp|route/g, "Array"));
  });

  it("keeps a trailing block comment and an own-line comment in place", () => {
    const withBlockComment = insertArrayItem(
      'const app = defineApp({\n  routes: [\n    route("/a", "./a.tsx") /* note { */\n  ],\n});\n',
      "routes",
      NEW_ROUTE,
    );
    expect(withBlockComment).toContain('route("/a", "./a.tsx"), /* note { */');
    expectParses(withBlockComment.replace(/defineApp|route/g, "Array"));

    const withOwnLineComment = insertArrayItem(
      'const app = defineApp({\n  routes: [\n    route("/a", "./a.tsx"),\n    // TODO: pricing\n  ],\n});\n',
      "routes",
      NEW_ROUTE,
    );
    expect(withOwnLineComment).toContain("// TODO: pricing");
    expectParses(withOwnLineComment.replace(/defineApp|route/g, "Array"));
  });

  it("locates the block through comments containing quotes or delimiters", () => {
    // `findMatchingDelimiter` tracks quotes but not comments, so an apostrophe
    // in `// don't` used to open a phantom string that swallowed the rest of
    // the file, and a stray `]` inside a comment closed the block early —
    // producing broken source with exit 0.
    for (const comment of ["// don't do this", "// see foo]", '// says "hi ]']) {
      const result = insertArrayItem(
        `const app = defineApp({\n  routes: [\n    route("/a", "./a.tsx") ${comment}\n  ],\n});\n`,
        "routes",
        NEW_ROUTE,
      );
      expect(result).toContain(comment);
      expectParses(result.replace(/defineApp|route/g, "Array"));
    }
  });

  it("does not double up an existing trailing comma", () => {
    const result = insertArrayItem(
      'const app = defineApp({\n  routes: [\n    route("/a", "./a.tsx"),\n  ],\n});\n',
      "routes",
      NEW_ROUTE,
    );
    expect(result).not.toContain(",,");
    expectParses(result.replace(/defineApp|route/g, "Array"));
  });
});

describe("upsertObjectEntry", () => {
  it("appends without trailing whitespace and with a trailing comma", () => {
    const result = upsertObjectEntry(
      'const app = defineApp({\n  middleware: {\n    auth: "./middleware/auth.ts",\n  },\n  routes: [],\n});\n',
      "middleware",
      'ratelimit: "./middleware/ratelimit.ts"',
    );

    expect(result).toContain('    ratelimit: "./middleware/ratelimit.ts",');
    expect(result.split("\n").some((line) => line !== line.trimEnd())).toBe(false);
  });
});

describe("ensureCoreNamedImport", () => {
  it("is a byte-for-byte no-op when the name is already imported", () => {
    const source = 'import {\n  defineApp,\n  route,\n} from "@pracht/core";\n';
    expect(ensureCoreNamedImport(source, "route")).toBe(source);
  });

  it("appends rather than reordering an existing list", () => {
    // Sorting would reintroduce the unrelated diff hunk this exists to avoid.
    expect(
      ensureCoreNamedImport('import { route, defineApp } from "@pracht/core";\n', "group"),
    ).toContain('import { route, defineApp, group } from "@pracht/core";');
  });

  it("preserves a multi-line import shape", () => {
    const result = ensureCoreNamedImport(
      'import {\n  defineApp,\n  route,\n} from "@pracht/core";\n',
      "group",
    );
    expect(result).toContain("import {\n  defineApp,\n  route,\n  group,\n} from");
  });
});

describe("exportsMiddleware", () => {
  it.each([
    ["export const middleware: MiddlewareFn = async (a, n) => n();", true],
    ["export function middleware(a, n) { return n(); }", true],
    ["export async function middleware(a, n) { return n(); }", true],
    ["const mw = 1;\nexport { mw as middleware };", true],
    ["const middleware = 1;\nexport { middleware };", true],
    ["export const { middleware } = createAuth();", true],
    ["export const { mw: middleware } = createAuth();", true],
    // A type annotation sits between the pattern and `=` in a .ts module.
    ["export const { middleware }: Handlers = createAuth();", true],
    ["export const [middleware]: Fn[] = createAuth();", true],
    // Nested patterns bind on the value side.
    ["export const { auth: { middleware } } = createAuth();", true],
    ["export const { middleware: { inner } } = createAuth();", false],
    ["export const { middleware = fallback } = createAuth();", true],
    ["export const [a, middleware] = createAuth();", true],
    // `{ middleware: mw }` binds `mw` — the same trap as `middleware as default`.
    ["export const { middleware: mw } = createAuth();", false],
    ["export const [mw] = createAuth();", false],
    ['export * from "./shared.ts";', true],
    ["export { a, mw as middleware, b };", true],
    // `middleware as default` exports `default`, not `middleware` — the exact
    // mistake this check exists to catch.
    ["const middleware = 1;\nexport { middleware as default };", false],
    ["export default async (a, n) => n();", false],
    ["export const authMiddleware = 1;", false],
    ["export { a, middleware as thing, b };", false],
    // Comments and strings are masked, so neither can fake an export.
    ["// export const middleware = 1;\nexport default 1;", false],
    ['const doc = "export const middleware";\nexport default 1;', false],
  ])("classifies %j as %s", (source, expected) => {
    expect(exportsMiddleware(source)).toBe(expected);
  });
});
