import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { defineCapability, mcpToolServing } from "../src/index.ts";
import {
  CAPABILITY_DESCRIPTOR_FIELDS,
  capabilityDescriptorFromGraph,
  capabilityGraphFields,
  describeCapability,
  diffCapabilityDescriptors,
  isValidOAuthScopeToken,
  MCP_AUTH_CONFIG_KEYS,
  MCP_CONFIG_KEYS,
  normalizeCapabilityDescriptor,
  readStaticCapability,
  type CapabilityDescriptor,
} from "../src/static.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The docs example's capabilities read a build-time index from a Vite virtual
// module; it is only touched on the first tool call.
vi.mock("virtual:docs-mcp-index", () => ({ default: {} }));

/**
 * The exhaustive-key gate. Adding a field to `CapabilityDescriptor` fails to
 * compile here until it is listed, and the runtime checks below then fail
 * until every producer fills it in and the drift table can describe it.
 */
const DESCRIPTOR_KEYS = {
  title: true,
  description: true,
  effect: true,
  http: true,
  mcp: true,
  webmcp: true,
  agentPolicy: true,
  middleware: true,
} satisfies Record<keyof CapabilityDescriptor, true>;

const sortedKeys = (value: object) => Object.keys(value).sort();

describe("CapabilityDescriptor keys", () => {
  const expected = sortedKeys(DESCRIPTOR_KEYS);
  const definition = {
    title: "Search notes",
    description: "Find notes.",
    effect: "read",
    expose: { http: true, mcp: true, webmcp: true } as const,
  };

  it("every producer emits every key", () => {
    const executed = normalizeCapabilityDescriptor(definition, { source: "executed" }).descriptor;
    const statically = readStaticCapability(
      "notes.search",
      `export default defineCapability(${JSON.stringify(definition)});`,
    )!.descriptor;
    const described = describeCapability(
      defineCapability({
        ...definition,
        effect: "read",
        input: { type: "object" },
        output: { type: "object" },
        run: () => ({}),
      }),
      "notes.search",
    );
    const fromGraph = capabilityDescriptorFromGraph(capabilityGraphFields(described));

    for (const descriptor of [executed, statically, described, fromGraph]) {
      expect(sortedKeys(descriptor)).toEqual(expected);
    }
  });

  it("the drift table describes every key", () => {
    expect(sortedKeys(CAPABILITY_DESCRIPTOR_FIELDS)).toEqual(expected);
  });
});

/** Capability modules across the repo: this package's fixtures, the examples, the CLI fixtures. */
function collectCapabilityFixtures(): string[] {
  const roots = [
    join(REPO_ROOT, "packages/capabilities/test/fixtures/descriptor"),
    ...readdirSync(join(REPO_ROOT, "examples")).map((example) =>
      join(REPO_ROOT, "examples", example, "src/capabilities"),
    ),
    join(REPO_ROOT, "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      if (!statSync(root).isDirectory()) continue;
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/\.tsx?$/.test(entry)) files.push(join(root, entry));
    }
  }
  return files.sort();
}

/** Fixtures whose modules import Worker-only runtime modules and cannot run under Node. */
const NOT_EXECUTABLE_IN_NODE = new Set([
  "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities/binding-reflection.ts",
  "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities/binding-use.ts",
  "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities/edge-runtime.ts",
  "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities/runtime-construction.ts",
  "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities/runtime-helper-call.ts",
  "packages/cli/test/fixtures/cloudflare-runtime-import/src/capabilities/unknown-runtime.ts",
]);

/** Fields static analysis cannot read in a fixture, by design of that fixture. */
const STATICALLY_UNREADABLE: Record<string, (keyof CapabilityDescriptor)[]> = {
  "packages/capabilities/test/fixtures/descriptor/computed-expose.ts": [
    "title",
    "http",
    "mcp",
    "webmcp",
  ],
  "packages/capabilities/test/fixtures/descriptor/spread-guards.ts": ["agentPolicy", "middleware"],
};

describe("static and executed descriptors agree", () => {
  const fixtures = collectCapabilityFixtures();

  it("covers scoped, computed-expose, and example capabilities", () => {
    const names = fixtures.map((file) => relative(REPO_ROOT, file));
    expect(names).toContain("packages/capabilities/test/fixtures/descriptor/scoped-mcp.ts");
    expect(names).toContain("packages/capabilities/test/fixtures/descriptor/computed-expose.ts");
    expect(names.filter((name) => name.startsWith("examples/")).length).toBeGreaterThan(5);
  });

  it.each(fixtures.map((file) => [relative(REPO_ROOT, file), file]))("%s", async (name, file) => {
    const capabilityName = basename(file).replace(/\.tsx?$/, "");
    const read = readStaticCapability(capabilityName, readFileSync(file, "utf-8"));
    expect(read, "static analysis finds the defineCapability() call").not.toBeNull();
    const statically = read!.descriptor;

    if (NOT_EXECUTABLE_IN_NODE.has(name)) {
      await expect(import(pathToFileURL(file).href)).rejects.toThrow();
      expect(read!.problems).toEqual([]);
      return;
    }

    const module = (await import(pathToFileURL(file).href)) as {
      default: Parameters<typeof describeCapability>[0];
    };
    const executed = describeCapability(module.default, capabilityName);

    const unreadable = STATICALLY_UNREADABLE[name] ?? [];
    const expectedStatic = { ...executed } as Record<string, unknown>;
    for (const key of unreadable) expectedStatic[key] = undefined;

    expect(read!.problems).toEqual([]);
    expect(statically).toEqual(expectedStatic);
    expect(diffCapabilityDescriptors(executed, statically)).toEqual([]);
    // The graph round trip loses only what the graph does not carry.
    expect(
      diffCapabilityDescriptors(
        executed,
        capabilityDescriptorFromGraph(capabilityGraphFields(executed)),
      ),
    ).toEqual([]);
  });
});

describe("normalizeCapabilityDescriptor", () => {
  const base = {
    title: "Search notes",
    description: "Find notes.",
    effect: "read",
  };

  // Each rule is reported identically whether the definition was executed or
  // read from source, so runtime, build, and verify cannot disagree.
  it.each([
    [{ expose: { mcp: { scopes: ["has space"] } } }, 'MCP exposure "scopes" must be an array'],
    [{ expose: { mcp: { scopes: "openid" } } }, 'MCP exposure "scopes" must be an array'],
    [{ expose: { http: { method: "GET" } } }, 'HTTP exposure only supports method: "POST"'],
    [{ expose: { http: { path: "//evil.example" } } }, 'HTTP exposure "path" must be an exact'],
    [{ expose: { http: "yes" } }, '"expose.http" must be true or an object'],
    [{ expose: { mcp: "yes" } }, '"expose.mcp" must be a boolean or an options object'],
    [{ expose: { mcp: 1 } }, '"expose.mcp" must be a boolean or an options object'],
    [{ expose: { http: true, mpc: true } }, 'unknown "expose" key "mpc"'],
    [{ expose: { http: true, webmcp: "on" } }, '"expose.webmcp" must be a boolean'],
    [
      { expose: { http: true, webmcp: { untrustedContent: "yes" } } },
      'WebMCP exposure "untrustedContent" must be a boolean',
    ],
    [{ expose: { webmcp: true } }, "expose.webmcp requires expose.http"],
    [
      { effect: "destructive", expose: { http: true, webmcp: true } },
      "destructive capabilities cannot be exposed to WebMCP page tools",
    ],
    [{ effect: "delete" }, '"effect" must be "read", "write", or "destructive"'],
    [{ agentPolicy: "requre" }, '"agentPolicy" must be "observe" or "require"'],
    [{ middleware: "auth" }, '"middleware" must be an array of names'],
    [{ title: "  " }, '"title" must be a non-empty string'],
  ])("reports %j the same from both sources", (patch, message) => {
    const definition = { ...base, ...patch };
    const executed = normalizeCapabilityDescriptor(definition, { source: "executed" });
    const statically = readStaticCapability(
      "notes.search",
      `export default defineCapability(${JSON.stringify(definition)});`,
    )!;
    expect(executed.problems.map((problem) => problem.message)).toEqual(
      statically.problems.map((problem) => problem.message),
    );
    expect(executed.problems.map((problem) => problem.message).join("\n")).toContain(message);
    expect(() =>
      defineCapability({
        ...(definition as typeof base & { effect: "read" }),
        input: { type: "object" },
        output: { type: "object" },
        run: () => ({}),
      }),
    ).toThrow(message);
  });

  it("dedupes scopes and treats an empty list as unscoped", () => {
    const { descriptor } = normalizeCapabilityDescriptor(
      { ...base, expose: { mcp: { scopes: ["a", "a", "b"] } } },
      { source: "executed" },
    );
    expect(descriptor.mcp).toEqual({ scopes: ["a", "b"] });
    expect(
      normalizeCapabilityDescriptor(
        { ...base, expose: { mcp: { scopes: [] } } },
        { source: "static" },
      ).descriptor.mcp,
    ).toEqual({ scopes: [] });
  });

  it("leaves unreadable static fields unknown instead of guessing", () => {
    const { descriptor, problems } = normalizeCapabilityDescriptor(
      { effect: "read" },
      {
        source: "static",
        unreadable: new Set(["title", "description", "expose", "agentPolicy", "middleware"]),
      },
    );
    expect(problems).toEqual([]);
    expect(descriptor).toEqual({
      title: undefined,
      description: undefined,
      effect: "read",
      http: undefined,
      mcp: undefined,
      webmcp: undefined,
      agentPolicy: undefined,
      middleware: undefined,
    });
  });

  it("feeds mcpToolServing directly", () => {
    const scoped = normalizeCapabilityDescriptor(
      { ...base, expose: { mcp: { scopes: ["notes:read"] } } },
      { source: "executed" },
    ).descriptor;
    expect(mcpToolServing(scoped, { endpoint: true })).toBe("scopes-need-auth");
    expect(mcpToolServing(scoped, { endpoint: true, auth: true })).toBe("served");
  });
});

describe("diffCapabilityDescriptors", () => {
  const descriptor: CapabilityDescriptor = {
    title: "Search notes",
    description: "Find notes.",
    effect: "read",
    http: { path: "/api/capabilities/notes/search" },
    mcp: { scopes: ["notes:read"] },
    webmcp: null,
    agentPolicy: null,
    middleware: ["auth"],
  };
  const names = { a: "the app graph", b: "static analysis" };

  it("compares MCP exposure and its scopes", () => {
    expect(
      diffCapabilityDescriptors(descriptor, { ...descriptor, mcp: { scopes: [] } }, names),
    ).toEqual([
      'MCP exposure is on with scopes "notes:read" in the app graph but on without scopes in static analysis',
    ]);
    expect(diffCapabilityDescriptors(descriptor, { ...descriptor, mcp: null }, names)).toEqual([
      'MCP exposure is on with scopes "notes:read" in the app graph but off in static analysis',
    ]);
  });

  it("compares every key, including guards", () => {
    expect(
      diffCapabilityDescriptors(
        descriptor,
        { ...descriptor, agentPolicy: "require", middleware: [] },
        names,
      ),
    ).toEqual([
      'agentPolicy is inherited in the app graph but "require" in static analysis',
      'middleware is ["auth"] in the app graph but none in static analysis',
    ]);
  });

  it("skips values either side could not determine", () => {
    expect(
      diffCapabilityDescriptors(
        { ...descriptor, webmcp: { untrustedContent: undefined } },
        { ...descriptor, title: undefined, webmcp: { untrustedContent: true } },
      ),
    ).toEqual([]);
  });

  it("reports a key outside the drift table rather than skipping it", () => {
    const extra = { ...descriptor, surprise: 1 } as CapabilityDescriptor;
    expect(diffCapabilityDescriptors(descriptor, extra)).toEqual([]);
    expect(
      diffCapabilityDescriptors({ ...descriptor, surprise: 2 } as CapabilityDescriptor, extra),
    ).toEqual(["surprise is 2 in the first reading but 1 in the second reading"]);
  });
});

describe("agents.mcp option keys", () => {
  it("lists every option the config types declare", () => {
    expect(MCP_CONFIG_KEYS).toEqual([
      "path",
      "serverInfo",
      "instructions",
      "destructive",
      "auth",
      "pageSize",
      "allowedOrigins",
    ]);
    expect(MCP_AUTH_CONFIG_KEYS).toEqual([
      "resource",
      "authorizationServers",
      "scopesSupported",
      "requiredScopes",
      "resourceDocumentation",
      "verify",
    ]);
  });
});

describe("seam guard: one OAuth scope-token validator", () => {
  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...sourceFiles(path));
      else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name)) files.push(path);
    }
    return files;
  }

  const files = readdirSync(join(REPO_ROOT, "packages")).flatMap((pkg) => {
    const src = join(REPO_ROOT, "packages", pkg, "src");
    try {
      return statSync(src).isDirectory() ? sourceFiles(src) : [];
    } catch {
      return [];
    }
  });

  it("defines the RFC 6749 scope-token rule exactly once", () => {
    // The character class of `scope-token`, however a copy spells it.
    const rule = /\\x21\\x23-\\x5b\\x5d-\\x7e|\\u0021\\u0023-\\u005b\\u005d-\\u007e/;
    const validator = /function\s+\w*scope\w*token\w*\s*\(/i;
    const hits = files.filter((file) => {
      const source = readFileSync(file, "utf-8");
      return rule.test(source) || validator.test(source);
    });
    expect(hits.map((file) => relative(REPO_ROOT, file))).toEqual([
      "packages/capabilities/src/descriptor.ts",
    ]);
    expect(isValidOAuthScopeToken("notes:read")).toBe(true);
    expect(isValidOAuthScopeToken('has"quote')).toBe(false);
  });

  it("lists the agents.mcp option keys exactly once", () => {
    const hits = files.filter((file) =>
      /\bMCP_(?:AUTH_)?CONFIG_KEY(?:S|_MAP)\s*=/.test(readFileSync(file, "utf-8")),
    );
    expect(hits.map((file) => relative(REPO_ROOT, file))).toEqual([
      "packages/capabilities/src/agents-config-keys.ts",
    ]);
  });
});
