import { describe, expect, it } from "vitest";
import { parseAst } from "vite";

import {
  evaluateLiteral,
  extractCapabilityProjection,
  extractCapabilityRegistrations,
  extractDefineCapabilityArgs,
  extractManifestModuleRegistrations,
  hasNamedMiddlewareExport,
  scanTopLevelProperties,
} from "../src/static.ts";

describe("middleware export classification", () => {
  it.each([
    ["export const helper = 1, middleware = () => {};", true],
    ["export function middleware() {}\nmiddleware = 1;", false],
    ["export const middleware = 1;", false],
    ["export const middleware = 1 + 2;", false],
    ["export const middleware = 1 < 2;", false],
    ["let value = 0; export const middleware = value++;", false],
    ["export const middleware = <unknown>1;", false],
    ["export let middleware;", false],
    ["let middleware;\nmiddleware = () => {};\nexport { middleware };", true],
    ["export let middleware;\nmiddleware = () => {};", true],
    ["let middleware = () => {};\nmiddleware = 1;\nexport { middleware };", false],
    ["let middleware = () => {};\nmiddleware = 1, void 0;\nexport { middleware };", false],
    ["let middleware = () => {};\nvoid (middleware = 1);\nexport { middleware };", false],
    ["let middleware = () => {};\n[middleware = 1];\nexport { middleware };", false],
    [
      "let middleware = () => {};\nconst observed = (middleware = 1);\nexport { middleware };",
      false,
    ],
    ["let middleware = () => {};\nif ((middleware = 1)) {}\nexport { middleware };", false],
    [
      "let middleware = () => {};\nclass Setup { static value = (middleware = 1); }\nexport { middleware };",
      false,
    ],
    [
      "let middleware = () => {};\nclass Setup { static { middleware = 1; } }\nexport { middleware };",
      false,
    ],
    [
      "let middleware = () => {};\ntry { middleware = 1; } finally {}\nexport { middleware };",
      false,
    ],
    [
      "let middleware = () => {};\ntry {} finally { middleware = 1; }\nexport { middleware };",
      false,
    ],
    [
      "let middleware = () => {};\ndo { middleware = 1; } while (false);\nexport { middleware };",
      false,
    ],
    ["let middleware = () => {};\nsetup: middleware = 1;\nexport { middleware };", false],
    [
      "let middleware = () => {}, value;\n({ [middleware = 1]: value } = {});\nexport { middleware };",
      false,
    ],
    [
      "let middleware = () => {}, target = {};\n[target[middleware = 1]] = [0];\nexport { middleware };",
      false,
    ],
    [
      "let middleware = () => {};\nclass Setup { value = (middleware = 1); method() { middleware = 1; } }\nexport { middleware };",
      true,
    ],
    ["let middleware = () => {}, other;\nother = middleware = 1;\nexport { middleware };", false],
    [
      "let middleware = () => {};\nmiddleware = (middleware = 1, () => {});\nexport { middleware };",
      true,
    ],
    [
      "let middleware = () => {}, other = false;\nother &&= middleware = 1;\nexport { middleware };",
      true,
    ],
    [
      "let middleware = () => {}, service;\nservice?.use(middleware = 1);\nexport { middleware };",
      true,
    ],
    ["let middleware = 1;\nmiddleware = 2;\nexport { middleware };", false],
    ["let middleware = () => {};\nmiddleware++;\nexport { middleware };", false],
    [
      "let candidate = () => {};\ncandidate = 1;\nconst middleware = candidate;\nexport { middleware };",
      false,
    ],
    [
      "let candidate = 1;\nconst middleware = candidate;\ncandidate = () => {};\nexport { middleware };",
      false,
    ],
    [
      "let candidate = 1;\ncandidate = () => {};\nconst middleware = candidate;\nexport { middleware };",
      true,
    ],
    ["export const middleware = (() => {}) as MiddlewareFn;", true],
    ["export const middleware = <MiddlewareFn>(() => {});", true],
    ["const candidate = {};\nexport { candidate as middleware };", false],
    ["const candidate = 1;\nexport const middleware = candidate;", false],
    ["const value = {};\nconst candidate = value;\nexport { candidate as middleware };", false],
    [
      "const value = 1;\nconst candidate = <unknown>value;\nexport { candidate as middleware };",
      false,
    ],
    ["const candidate = () => {};\nexport const middleware = candidate;", true],
    ['import * as candidate from "./middleware.ts";\nexport { candidate as middleware };', false],
    ['import * as candidate from "./middleware.ts";\nexport const middleware = candidate;', false],
    ["export const { middleware } = { middleware: 1 };", false],
    ["const candidate = 1;\nexport const { middleware } = { middleware: candidate };", false],
    ["export const [middleware] = [null];", false],
    ["export const { middleware } = { middleware: () => {} };", true],
    ["export const { middleware } = { set middleware(value) {} };", false],
    ["export const { middleware } = { get middleware() { return createMiddleware(); } };", true],
    [
      "export const { middleware } = { get middleware() { return createMiddleware(); }, set middleware(value) {} };",
      true,
    ],
    ["export const { middleware } = { middleware() {} };", true],
    ["export const { middleware = () => {} } = {};", true],
    ["export const { middleware } = { middleware: 1, ...handlers };", true],
    ["export const { middleware } = { ...handlers, middleware: 1 };", false],
    ["const { candidate } = { candidate: 1 };\nexport { candidate as middleware };", false],
    ["const candidate = createMiddleware();\nexport { candidate as middleware };", true],
    [
      'function candidate() {}\nnamespace candidate { export const id = "pages"; }\nexport { candidate as middleware };',
      true,
    ],
    [
      "namespace Middlewares { export const auth = () => {}; }\nimport middleware = Middlewares.auth;\nexport { middleware };",
      true,
    ],
    [
      "namespace Middlewares { export const auth = () => {}; }\nexport import middleware = Middlewares.auth;",
      true,
    ],
    ["namespace Helpers { export const middleware = () => {}; }\nexport { Helpers };", false],
    ["type Contract = () => void;\nexport { Contract as middleware };", false],
    ["export { missing as middleware };", false],
    ['export { middleware } from "./middleware.ts";', true],
  ])("classifies %j as %s", (source, expected) => {
    expect(hasNamedMiddlewareExport(parseAst(source, { lang: "ts" }))).toBe(expected);
  });
});

describe("capability static extraction", () => {
  it("extracts non-capability manifest module registries", () => {
    const source = `
      export const app = defineApp({
        middleware: {
          // ignored: () => import("./middleware/ignored.ts"),
          pages: () => import("./pages/_middleware.ts"),
          auth: "./middleware/auth.ts",
        },
        routes: [],
      });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
      { name: "auth", file: "./middleware/auth.ts" },
    ]);
  });

  it.each([
    ["123", "123"],
    ["0x10", "16"],
    ["0b10", "2"],
    ["0o10", "8"],
    ["1_000", "1000"],
    [".5", "0.5"],
    ["1n", "1"],
  ])("preserves the numeric manifest registry key %s", (sourceKey, runtimeKey) => {
    const source = `
      export const app = defineApp({
        capabilities: {
          ${sourceKey}: () => import("./capabilities/numeric.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: runtimeKey, file: "./capabilities/numeric.ts" },
    ]);
  });

  it("resolves manifest module refs stored in top-level bindings", () => {
    const source = `
      const pagesMiddleware: ModuleRef = () => import("./pages/_middleware.ts");
      export const app = defineApp({
        middleware: { ...sharedMiddleware, pages: pagesMiddleware },
        routes: [],
      });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
    ]);
  });

  it.each([
    ["an unresolved spread", "...runtimeRegistry"],
    ["an unresolved computed property", '[runtimeName]: "./capabilities/runtime.ts"'],
  ])("forgets registrations preceding %s", (_description, opaqueProperty) => {
    const source = `
      const runtimeRegistry = getRuntimeRegistry();
      const runtimeName = getRuntimeName();
      export const app = defineApp({
        capabilities: {
          before: "./capabilities/before.ts",
          ${opaqueProperty},
          after: "./capabilities/after.ts",
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "after", file: "./capabilities/after.ts" },
    ]);
  });

  it("preserves registrations across statically resolvable object spreads", () => {
    const source = `
      export const app = defineApp({
        capabilities: {
          before: "./capabilities/before.ts",
          ...{},
          ...{ before: "./capabilities/replaced.ts", after: "./capabilities/after.ts" },
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "before", file: "./capabilities/replaced.ts" },
      { name: "after", file: "./capabilities/after.ts" },
    ]);
  });

  it("resolves shorthand manifest registries and module refs", () => {
    const source = `
      const pages = () => import("./pages/_middleware.ts");
      const middleware = { pages };
      export const app = defineApp({
        middleware,
        routes: [],
      });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
    ]);
  });

  it("resolves typed shorthand registries and module refs", () => {
    const source = `
      const pages: (() => Promise<unknown>) = () => import("./pages/_middleware.ts");
      const middleware: Record<string, () => Promise<unknown>> = { pages };
      export const app = defineApp({
        middleware,
        routes: [],
      });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
    ]);
  });

  it("unwraps parenthesized TypeScript registry and module-ref assertions", () => {
    const source = `
      const notes = (() => import("./capabilities/notes.ts")) satisfies (() => Promise<unknown>);
      const capabilities = ({ notes }) as Record<string, () => Promise<unknown>>;
      export const app = defineApp({ capabilities, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it.each(["as", "satisfies"])(
    "resolves aliases with unparenthesized function types using %s",
    (operator) => {
      const source = `
        const direct = () => import("./capabilities/notes.ts");
        const notes = direct ${operator} () => Promise<unknown>;
        export const app = defineApp({ capabilities: { notes }, routes: [] });
      `;

      expect(extractCapabilityRegistrations(source)).toEqual([
        { name: "notes", file: "./capabilities/notes.ts" },
      ]);
    },
  );

  it.each(["as", "satisfies"])(
    "resolves semicolonless asserted aliases before the exported app using %s",
    (operator) => {
      const source = `
        const sourcePath = "./capabilities/notes.ts"
        const notes = sourcePath ${operator} ModuleRef
        export const app = defineApp({ capabilities: { notes }, routes: [] });
      `;

      expect(extractCapabilityRegistrations(source)).toEqual([
        { name: "notes", file: "./capabilities/notes.ts" },
      ]);
    },
  );

  it("resolves TypeScript-asserted transitive registry aliases", () => {
    const source = `
      const middlewareSource = "./pages/_middleware.ts";
      const pages = middlewareSource satisfies string;
      const directRegistry = { pages };
      const middleware = directRegistry as Record<string, string>;
      export const app = defineApp({ middleware, routes: [] });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
    ]);
  });

  it("does not unwrap calls around module-ref factories", () => {
    const source = `
      const factory = () => import("./capabilities/notes.ts");
      const notes = (factory)();
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("does not unwrap asserted expressions with runtime continuations", () => {
    const source = `
      const first = () => import("./capabilities/first.ts");
      const second = () => import("./capabilities/second.ts");
      const notes = (first) satisfies (() => Promise<unknown>) ? first : second;
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("does not unwrap parenthesized sequence expressions", () => {
    const source = `
      const first = () => import("./capabilities/first.ts");
      const second = () => import("./capabilities/second.ts");
      const notes = (first, second);
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("does not truncate a continued alias expression at a line break", () => {
    const source = `
      const first = () => import("./capabilities/first.ts");
      const second = () => import("./capabilities/second.ts");
      const notes = first
        ? second
        : first;
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("resolves semicolonless aliases before a control-flow statement", () => {
    const source = `
      const sourcePath = "./capabilities/notes.ts"
      const notes = sourcePath
      if (process.env.NODE_ENV === "test") {}
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it("resolves semicolonless aliases before an async function declaration", () => {
    const source = `
      const sourcePath = "./capabilities/notes.ts"
      const notes = sourcePath
      async function prepareRegistry() {}
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it("resolves semicolonless aliases before the next declaration", () => {
    const source = `
      const sourcePath = "./capabilities/notes.ts"
      const notes = sourcePath
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it.each(["let", "var"])("does not resolve mutable %s aliases", (declaration) => {
    const source = `
      const first = () => import("./capabilities/first.ts");
      const second = () => import("./capabilities/second.ts");
      ${declaration} notes = first;
      notes = second;
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("resolves registry objects and module refs in later variable declarators", () => {
    const source = `
      const unusedRef = () => import("./middleware/unused.ts"),
        pages: (() => Promise<unknown>) = () => import("./pages/_middleware.ts");
      const unusedRegistry = {},
        middleware: Record<string, () => Promise<unknown>> = { pages };
      export const app = defineApp({ middleware, routes: [] });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
    ]);
  });

  it("resolves transitive aliases for registries and module refs", () => {
    const source = `
      const middlewareSource = "./pages/_middleware.ts";
      const pages = middlewareSource;
      const directRegistry = { pages };
      const middleware = directRegistry;
      export const app = defineApp({ middleware, routes: [] });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([
      { name: "pages", file: "./pages/_middleware.ts" },
    ]);
  });

  it.each([
    [
      "directly",
      `
        const capabilities = { notes: "./capabilities/original.ts" };
        capabilities.notes = "./capabilities/runtime.ts";
        export const app = defineApp({ capabilities, routes: [] });
      `,
    ],
    [
      "through an alias",
      `
        const registry = { notes: "./capabilities/original.ts" };
        const capabilities = registry;
        capabilities.notes = "./capabilities/runtime.ts";
        export const app = defineApp({ capabilities, routes: [] });
      `,
    ],
  ])("keeps a registry mutated %s opaque", (_description, source) => {
    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("keeps a registry used by a braced control statement opaque", () => {
    const source = `
      const capabilities = { notes: "./capabilities/original.ts" };
      if (capabilities) {
        capabilities.notes = "./capabilities/runtime.ts";
      }
      export const app = defineApp({ capabilities, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it.each([
    [
      "ordinary function",
      `function inspect(capabilities) {
        return capabilities;
      }`,
    ],
    [
      "object method",
      `const helper = {
        capabilities() {},
        inspect(capabilities) { return capabilities; },
      };`,
    ],
    ["parenthesized arrow function", "const inspect = (capabilities) => capabilities;"],
    ["bare-parameter arrow function", "const inspect = capabilities => capabilities;"],
    ["block-bodied arrow function", "const inspect = (capabilities) => { return capabilities; };"],
  ])("ignores uses shadowed by an %s when checking a registry", (_description, declaration) => {
    const source = `
      const capabilities = { notes: "./capabilities/notes.ts" };
      ${declaration}
      export const app = defineApp({ capabilities, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it("keeps a registry used from a function body opaque", () => {
    const source = `
      const capabilities = { notes: "./capabilities/notes.ts" };
      function inspect(value) {
        return value && capabilities;
      }
      export const app = defineApp({ capabilities, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it.each([
    ["the registry", "typeof capabilities"],
    ["a registry member", "typeof capabilities.notes"],
    ["an indexed registry member", 'typeof capabilities["notes"]'],
    ["a multiline registry member", "\n        typeof capabilities.notes"],
  ])("ignores type-only queries of %s when checking for mutation", (_description, query) => {
    const source = `
      const capabilities = { notes: "./capabilities/notes.ts" };
      type CapabilityRegistry = ${query};
      export const app = defineApp({ capabilities, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it.each(["capabilities.trigger", 'capabilities["trigger"]', "capabilities!.trigger"])(
    "keeps a registry read through runtime typeof %s opaque",
    (query) => {
      const source = `
        const capabilities = {
          get trigger() {
            this.notes = "./capabilities/runtime.ts";
            return 0;
          },
          notes: "./capabilities/original.ts",
        };
        typeof ${query};
        export const app = defineApp({ capabilities, routes: [] });
      `;

      expect(extractCapabilityRegistrations(source)).toEqual([]);
    },
  );

  it.each(["string", "(() => void)", "Promise<string>"])(
    "keeps a runtime typeof read after the closed semicolonless type alias %s opaque",
    (type) => {
      const source = `
      const capabilities = {
        notes: "./capabilities/original.ts",
        get trigger() {
          this.notes = "./capabilities/runtime.ts";
          return 0;
        },
      };
      type Marker = ${type}
      typeof capabilities.trigger;
      export const app = defineApp({ capabilities, routes: [] });
    `;

      expect(extractCapabilityRegistrations(source)).toEqual([]);
    },
  );

  it("stops safely when manifest module aliases form a cycle", () => {
    const source = `
      const first = second, second = first;
      export const app = defineApp({
        capabilities: { "notes.search": first },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([]);
  });

  it("does not treat a default-import comma as a variable declarator", () => {
    const source = `
      import unused, pages from "./middleware-refs.ts"
      const fallback = () => import("./pages/_middleware.ts")
      export const app = defineApp({ middleware: { pages }, routes: [] });
    `;

    expect(extractManifestModuleRegistrations(source, "middleware")).toEqual([]);
  });

  it("does not treat a generic type comma as a variable declarator", () => {
    const source = `
      type notes = unknown;
      const metadata: Record<string, notes> = {};
      const notes = "./capabilities/notes.ts";
      export const app = defineApp({ capabilities: { notes }, routes: [] });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes", file: "./capabilities/notes.ts" },
    ]);
  });

  it("ignores defineCapability examples in comments and strings", () => {
    const source = `
      // defineCapability({ title: "commented out" })
      const example = "defineCapability({ title: 'inside a string' })";
      export default defineCapability({
        title: "Live capability",
        run() {},
      });
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "Live capability"');
  });

  it("extracts the default-exported call, not a preceding helper", () => {
    const source = `
      const helper = defineCapability({ title: "Helper", run() {} });
      export default defineCapability({
        title: "Exported",
        run() {},
      });
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).toContain('title: "Exported"');
    expect(args).not.toContain('title: "Helper"');
  });

  it("resolves an identifier default export to its declaration", () => {
    const source = `
      const cap = defineCapability({ title: "Via const", run() {} });
      export default cap;
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "Via const"');
  });

  it("resolves an identifier default export with no trailing semicolon (ASI)", () => {
    const source = `
      const cap = defineCapability({ title: "ASI", run() {} })
      export default cap
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "ASI"');
  });

  it("resolves an `export { cap as default }` re-export", () => {
    const source = `
      const cap = defineCapability({ title: "As default", run() {} });
      export { cap as default };
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "As default"');
  });

  it("resolves a declaration with an arrow-function type annotation", () => {
    const source = `
      const cap: () => unknown = defineCapability({ title: "Typed", run() {} });
      export default cap;
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "Typed"');
  });

  it("rejects a single call site that is not default-exported", () => {
    const source = `
      const cap = defineCapability({ title: "Only call", run() {} });
    `;

    expect(extractDefineCapabilityArgs(source)).toBeNull();
  });

  it("does not cross an ASI boundary to a later capability declaration", () => {
    const source = `
      const cap = factory()
      const helper = defineCapability({ title: "Wrong", run() {} })
      export default cap
    `;

    expect(extractDefineCapabilityArgs(source)).toBeNull();
  });

  it("rejects a named-only call when another value is default-exported", () => {
    const source = `
      export const helper = defineCapability({ title: "Wrong", run() {} });
      export default {};
    `;

    expect(extractDefineCapabilityArgs(source)).toBeNull();
  });

  it("resolves the module-scope binding, not a shadowed inner declaration", () => {
    const source = `
      function make() {
        const cap = defineCapability({ title: "Inner helper", run() {} });
        return cap;
      }
      const cap = defineCapability({ title: "Module scope", run() {} });
      export default cap;
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).toContain('title: "Module scope"');
    expect(args).not.toContain('title: "Inner helper"');
  });

  it("does not truncate at a nested template literal in run()", () => {
    const source = `
      export default defineCapability({
        title: "Templates",
        run({ input }) {
          const inner = \`prefix \${\`nested \${input.name}\`} suffix\`;
          return { message: inner };
        },
        effect: "read",
        expose: { http: true },
      });
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).toContain('effect: "read"');
    expect(args).toContain("expose:");
  });

  it("does not truncate at a brace inside a regex literal", () => {
    const source = `
      export default defineCapability({
        title: "Regex",
        run({ input }) {
          return { ok: input.text.match(/[{}]/) !== null };
        },
        effect: "read",
      });
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('effect: "read"');
  });

  it("recognizes regex expression statements after control-flow conditions", () => {
    const source = `
      export default defineCapability({
        title: "Conditional regex",
        description: "Tests input after a condition.",
        input: { type: "object" },
        output: { type: "object" },
        run({ input }) {
          if (input.text) /[}]/.test(input.text);
          return {};
        },
        effect: "read",
        expose: { http: true },
      });
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).toContain('effect: "read"');
    expect(args).toContain("expose:");
  });

  it("ignores entry-point lookalikes inside regex literals", () => {
    const source = `
      const pattern = /export default defineCapability()/;
      const decoy = { effect: "write", expose: { http: true } };
      export default defineCapability({
        title: "Real capability",
        description: "The actual default export.",
        input: { type: "object" },
        output: { type: "object" },
        effect: "read",
        expose: { http: false },
        run() { return {}; },
      });
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).toContain('title: "Real capability"');
    expect(args).toContain('effect: "read"');
    expect(args).not.toContain('effect: "write"');
  });

  it("parses Unicode code-point escapes in inline schemas", () => {
    const source = String.raw`
      export default defineCapability({
        title: "Emoji",
        description: "Accept one emoji.",
        input: { type: "string", enum: ["\u{1F600}"] },
        output: { type: "string" },
        effect: "read",
        expose: { http: true, webmcp: true },
        run() {},
      });
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).not.toBeNull();
    const input = scanTopLevelProperties(args!).get("input");
    expect(evaluateLiteral(input!)).toEqual({ type: "string", enum: ["😀"] });
  });

  it("parses code-point escapes with additional leading zeros", () => {
    expect(evaluateLiteral(String.raw`"\u{00000001}"`)).toBe("\u0001");
    expect(evaluateLiteral(String.raw`"\u{00010FFFF}"`)).toBe("\u{10ffff}");
  });

  it("ignores commented-out manifest registrations", () => {
    const source = `
      export const app = defineApp({
        capabilities: {
          // "notes.old": () => import("./capabilities/notes-old.ts"),
          /* "notes.draft": () => import("./capabilities/notes-draft.ts"), */
          "notes.search": () => import("./capabilities/notes-search.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes.search", file: "./capabilities/notes-search.ts" },
    ]);
  });

  it("extracts registrations from a quoted capabilities property", () => {
    const source = `
      const example = '"capabilities": { "notes.fake": "./fake.ts" }';
      export const app = defineApp({
        "capabilities": {
          "notes.search": "./capabilities/notes-search.ts",
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes.search", file: "./capabilities/notes-search.ts" },
    ]);
  });

  it("decodes escaped quoted manifest property names", () => {
    const source = String.raw`
      export const app = defineApp({
        "capabil\u0069ties": {
          "notes.search": "./capabilities/notes-search.ts",
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes.search", file: "./capabilities/notes-search.ts" },
    ]);
  });

  it("scopes registrations to the exported defineApp object", () => {
    const source = `
      const metadata = {
        capabilities: {
          "wrong.tool": () => import("./wrong.ts"),
        },
      };
      export const app = defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });

  it("ignores exported-app lookalikes inside regex literals", () => {
    const source = `
      const pattern = /export default defineApp()/;
      export default defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });

  it("extracts registrations from a typed exported app binding", () => {
    const source = `
      export const app: PrachtApp = defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });

  it("extracts registrations from a local binding re-exported as app", () => {
    const source = `
      const manifest = defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
      export { manifest as app };
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });
});

describe("extractCapabilityProjection guard fields", () => {
  const capability = (extra: string) => `
    import { defineCapability } from "@pracht/capabilities";
    export default defineCapability({
      title: "T",
      description: "D",
      input: { type: "object" },
      output: { type: "object" },
      effect: "read",
      expose: { http: true, mcp: true },
      ${extra}
      async run() { return {}; },
    });
  `;

  it("recovers mcp exposure, agentPolicy, and middleware from literals", () => {
    // The app graph falls back to this extractor when a capability module
    // cannot be executed (a Cloudflare capability importing
    // `cloudflare:workers` deploys fine but does not load under Node). These
    // are the fields a reviewer reads to decide whether a change weakened a
    // guard, so reporting them as absent would silence `pracht plan`.
    const projection = extractCapabilityProjection(
      "kv.get",
      capability('agentPolicy: "require",\n      middleware: ["auth"],'),
      (detail) => detail,
    );

    expect(projection.mcp).toBe(true);
    expect(projection.agentPolicy).toBe("require");
    expect(projection.middleware).toEqual(["auth"]);
  });

  it('distinguishes "absent" from "declared but unreadable"', () => {
    const absent = extractCapabilityProjection("kv.get", capability(""), (detail) => detail);
    expect(absent.agentPolicy).toBeNull();
    expect(absent.middleware).toEqual([]);

    // `undefined` is the signal the graph turns into `unverifiedContract`, so a
    // diff says "cannot detect changes" rather than "no change".
    const opaque = extractCapabilityProjection(
      "kv.get",
      capability("agentPolicy: POLICY,\n      middleware: SHARED,"),
      (detail) => detail,
    );
    expect(opaque.agentPolicy).toBeUndefined();
    expect(opaque.middleware).toBeUndefined();
  });
});
