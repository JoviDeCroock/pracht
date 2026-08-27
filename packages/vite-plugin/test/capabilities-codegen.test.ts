import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityErrorPayload } from "virtual:pracht/capabilities";

import {
  createPrachtCapabilitiesClientModuleSource,
  createPrachtWebmcpModuleSource,
  extractCapabilities,
} from "../src/plugin-capabilities.ts";
import {
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
} from "../src/plugin-codegen.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const SEARCH_CAPABILITY = `import { defineCapability } from "@pracht/capabilities";

// The interface between the import and the call guards the extractor against
// matching the import binding or the interface braces.
interface SearchInput {
  query: string;
  limit: number;
}

export default defineCapability<SearchInput>({
  title: "Search notes",
  description: "Find notes whose title matches the query.",
  input: {
    type: "object",
    properties: {
      // Text to search for.
      query: { type: "string", minLength: 1, description: "Text to search for." },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: { type: "object", properties: { notes: { type: "array" } }, required: ["notes"] },
  effect: "read",
  expose: {
    http: true,
    webmcp: true,
  },
  async run({ input }) {
    return { notes: [input.query] };
  },
});
`;

const CREATE_CAPABILITY = `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Create note",
  description: "Add a note.",
  input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  effect: "write",
  expose: { http: { path: "/api/create-note" } },
  async run() {
    return { id: "n1" };
  },
});
`;

const PRIVATE_CAPABILITY = `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Private op",
  description: "Server-only.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  async run() {
    return {};
  },
});
`;

function createFixture(options: {
  capabilities?: Record<string, string>;
  manifestCapabilitiesBlock?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-capabilities-codegen-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src/capabilities"), { recursive: true });
  mkdirSync(join(root, "src/routes"), { recursive: true });

  const capabilities = options.capabilities ?? {};
  for (const [file, source] of Object.entries(capabilities)) {
    writeFileSync(join(root, "src/capabilities", file), source, "utf-8");
  }

  const capabilitiesBlock =
    options.manifestCapabilitiesBlock ??
    (Object.keys(capabilities).length > 0
      ? `capabilities: {\n${Object.keys(capabilities)
          .map(
            (file) =>
              `    "${file.replace(/\.ts$/, "").replace(/-/g, ".")}": () => import("./capabilities/${file}"),`,
          )
          .join("\n")}\n  },`
      : "");

  writeFileSync(
    join(root, "src/routes.ts"),
    [
      'import { defineApp, route } from "@pracht/core";',
      "",
      "export const app = defineApp({",
      `  ${capabilitiesBlock}`,
      "  routes: [",
      '    route("/", () => import("./routes/home.tsx"), { id: "home" }),',
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(root, "src/routes/home.tsx"),
    "export function Component() { return null; }\n",
  );

  return root;
}

describe("extractCapabilities", () => {
  it("extracts registrations, exposure, and schemas from source", () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY,
        "notes-create.ts": CREATE_CAPABILITY,
        "notes-private.ts": PRIVATE_CAPABILITY,
      },
    });

    const capabilities = extractCapabilities({}, root);
    expect(capabilities).toHaveLength(3);

    const search = capabilities.find((entry) => entry.name === "notes.search");
    expect(search).toMatchObject({
      httpPath: "/api/capabilities/notes/search",
      webmcp: true,
      description: "Find notes whose title matches the query.",
      effect: "read",
    });
    // The full JSON Schema survives extraction for WebMCP registration.
    expect(search?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Text to search for." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    });

    expect(capabilities.find((entry) => entry.name === "notes.create")).toMatchObject({
      httpPath: "/api/create-note",
      webmcp: false,
      inputSchema: null,
    });

    expect(capabilities.find((entry) => entry.name === "notes.private")).toMatchObject({
      httpPath: null,
      webmcp: false,
    });
  });

  it("returns an empty list when the manifest registers no capabilities", () => {
    const root = createFixture({});
    expect(extractCapabilities({}, root)).toEqual([]);
  });

  it("fails loudly when a webmcp capability schema is not an inline literal", () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY.replace(
          /input: \{[\s\S]*?\n  \},/,
          "input: sharedSchema,",
        ),
      },
    });

    expect(() => extractCapabilities({}, root)).toThrow(/inline object literal/);
  });

  it("fails when an HTTP capability effect is not an inline literal", () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY.replace('effect: "read",', "effect: READ_EFFECT,"),
      },
    });

    expect(() => extractCapabilities({}, root)).toThrow(
      /HTTP-exposed capabilities must declare "effect" as an inline/,
    );
  });

  it("rejects protocol-relative custom HTTP paths", () => {
    const root = createFixture({
      capabilities: {
        "notes-create.ts": CREATE_CAPABILITY.replace(
          'path: "/api/create-note"',
          'path: "//evil.test/collect"',
        ),
      },
    });

    expect(() => extractCapabilities({}, root)).toThrow(/exact same-origin pathname/);
  });

  it("does not execute expressions while extracting projection metadata", () => {
    const marker = `__prachtProjectionExecuted_${Date.now()}`;
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY.replace(
          /input: \{[\s\S]*?\n  \},/,
          `input: (() => { globalThis.${marker} = true; return { type: "object" }; })(),`,
        ),
      },
    });

    try {
      expect(() => extractCapabilities({}, root)).toThrow(/inline object literal/);
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
    }
  });
});

/**
 * Import the generated module standalone. It imports `createUseCapability`
 * from `@pracht/core` (the hook's implementation lives there so it stays typed
 * and unit-tested), and a bare specifier cannot be resolved from a `data:` URL
 * — so swap just that specifier for an inline stub. Everything these tests
 * exercise (the endpoint table, dispatch, the settled event) is untouched;
 * the hook itself is covered by the framework's own tests.
 */
async function importGeneratedModule<T>(source: string): Promise<T> {
  const standalone = source.replace(
    'from "@pracht/core"',
    'from "data:text/javascript,export const createUseCapability = () => () => {};export const ensureCapabilityRevalidation = () => {};export const withBase = (p) => p;"',
  );
  const url = `data:text/javascript;base64,${Buffer.from(standalone).toString("base64")}#${Date.now()}`;
  return (await import(url)) as T;
}

describe("createPrachtCapabilitiesClientModuleSource", () => {
  it("types destructive confirmation metadata in browser envelopes", () => {
    const error = {
      code: "confirmation_required",
      message: "Confirm the call.",
      confirmationToken: "v1.payload.signature",
      expiresAt: 1_800_000_000,
    } satisfies CapabilityErrorPayload;

    expect(error.confirmationToken).toContain("v1.");
  });

  it("contains only http-exposed endpoints — no schemas, no server code", () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY,
        "notes-create.ts": CREATE_CAPABILITY,
        "notes-private.ts": PRIVATE_CAPABILITY,
      },
    });

    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    expect(source).toContain("notes.search");
    expect(source).toContain("/api/capabilities/notes/search");
    expect(source).toContain("notes.create");
    expect(source).toContain("/api/create-note");
    expect(source).not.toContain("notes.private");
    expect(source).not.toContain("defineCapability");
    expect(source).toContain("export async function callCapability");
  });

  it("dispatches to the capability endpoint under the deploy base", () => {
    // Endpoints are declared without the base; `withBase` is the runtime's
    // single source of truth for it, so the generated module must call it
    // rather than bake a path the browser would resolve at the origin root.
    const root = createFixture({ capabilities: { "notes-search.ts": SEARCH_CAPABILITY } });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    expect(source).toContain("await fetch(withBase(endpoint.path), {");
  });

  it("emits an empty endpoint map for apps without capabilities", () => {
    const root = createFixture({});
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    expect(source).toContain('JSON.parse("{}")');
  });

  it("binds useCapability to its own callCapability", () => {
    // `importGeneratedModule` stubs the @pracht/core import out, so assert on
    // the emitted text: renaming the export or the entry point it comes from
    // would otherwise only surface in e2e, at build time, in an example app.
    const root = createFixture({ capabilities: { "notes-search.ts": SEARCH_CAPABILITY } });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    expect(source).toContain(
      'import { createUseCapability, ensureCapabilityRevalidation, withBase } from "@pracht/core";',
    );
    expect(source).toContain("export const useCapability = /*@__PURE__*/ createUseCapability(");
    expect(source).toContain("createUseCapability(callCapability)");
  });

  it("keeps contract details out of the client module, nested client included", () => {
    // The browser projection may carry only what dispatch needs: names, paths,
    // and effects. Schemas, prose, and handler bodies are server-side contract
    // — WebMCP is the one place a schema legitimately crosses, and it lives in
    // its own module. Adding anything richer to the client (a description for
    // DX, a schema for client-side validation) would leak contract surface into
    // every visitor's bundle, so guard the payload rather than trusting review.
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY,
        "notes-create.ts": CREATE_CAPABILITY,
        "notes-private.ts": PRIVATE_CAPABILITY,
      },
    });

    const source = createPrachtCapabilitiesClientModuleSource({}, { root });

    // Prose from the capability contracts.
    expect(source).not.toContain("Find notes whose title matches the query.");
    expect(source).not.toContain("Search notes");
    // JSON Schema keywords — no schema should reach this module at all.
    for (const keyword of [
      "additionalProperties",
      "minLength",
      "properties",
      "required",
      'type":',
    ]) {
      expect(source).not.toContain(keyword);
    }
    // Handler bodies and the definition helper.
    expect(source).not.toContain("defineCapability");
    expect(source).not.toContain("run(");
    // Private capabilities leave no trace: not even their name.
    expect(source).not.toContain("private");
  });

  it("exposes dotted names as a nested client that dispatches like callCapability", async () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY,
        "notes-create.ts": CREATE_CAPABILITY,
        "notes-private.ts": PRIVATE_CAPABILITY,
      },
    });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });

    let requestUrl: string | undefined;
    let requestBody: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true, data: { notes: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const mod = await importGeneratedModule<{
        capabilities: Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
      }>(source);

      const result = await mod.capabilities.notes.search({ query: "roadmap" });

      expect(requestUrl).toBe("/api/capabilities/notes/search");
      expect(JSON.parse(requestBody ?? "{}")).toEqual({ query: "roadmap" });
      expect(result).toEqual({ ok: true, data: { notes: [] } });

      // Custom `expose.http.path` is honoured through the nested client too.
      expect(typeof mod.capabilities.notes.create).toBe("function");
      // Private capabilities have no endpoint, so they are absent entirely —
      // the runtime counterpart of them being missing from the typed client.
      expect(mod.capabilities.notes.private).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builds special-name paths without inherited lookups or prototype pollution", async () => {
    const root = createFixture({
      capabilities: { "special.ts": CREATE_CAPABILITY },
      manifestCapabilitiesBlock: `capabilities: {
    "safe.__proto__.polluted": () => import("./capabilities/special.ts"),
    "__proto__": () => import("./capabilities/special.ts"),
  },`,
    });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    const originalFetch = globalThis.fetch;
    let requestUrl: string | undefined;
    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return Response.json({ ok: true, data: { id: "n1" } });
    }) as typeof fetch;

    try {
      const mod = await importGeneratedModule<{
        callCapability: (name: string, input?: unknown) => Promise<unknown>;
        capabilities: Record<string, unknown>;
      }>(source);

      expect(Object.getPrototypeOf(mod.capabilities)).toBeNull();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(
        (
          mod.capabilities.safe as {
            __proto__: { polluted: unknown };
          }
        ).__proto__.polluted,
      ).toBeTypeOf("function");

      await mod.callCapability("__proto__", { title: "safe" });
      expect(requestUrl).toBe("/api/create-note");
    } finally {
      globalThis.fetch = originalFetch;
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  });

  it("forwards caller-supplied headers for confirmation flows", async () => {
    const root = createFixture({
      capabilities: {
        "notes-create.ts": CREATE_CAPABILITY,
      },
    });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    let requestInit: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, data: { id: "n1" } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const mod = await importGeneratedModule<{
        callCapability: (
          name: string,
          input?: unknown,
          opts?: { headers?: HeadersInit },
        ) => Promise<unknown>;
      }>(source);
      await mod.callCapability(
        "notes.create",
        { title: "Confirmed note" },
        { headers: { "x-pracht-confirm": "token-1" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const headers = requestInit?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("content-type")).toBe("application/json");
    expect((headers as Headers).get("x-pracht-confirm")).toBe("token-1");
  });

  it("never forwards a confirmation token from a prepare-only call", async () => {
    const root = createFixture({
      capabilities: {
        "notes-create.ts": CREATE_CAPABILITY,
      },
    });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    let requestInit: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return Response.json({
        ok: false,
        error: { code: "confirmation_required", message: "Confirm", confirmationToken: "fresh" },
      });
    }) as typeof fetch;

    try {
      const mod = await importGeneratedModule<{
        callCapability: (
          name: string,
          input?: unknown,
          opts?: { headers?: HeadersInit; prepare?: true },
        ) => Promise<unknown>;
      }>(source);
      await mod.callCapability(
        "notes.create",
        { title: "Prepare only" },
        { prepare: true, headers: { "x-pracht-confirm": "must-not-commit" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const headers = requestInit?.headers;
    if (!(headers instanceof Headers)) throw new Error("expected generated client headers");
    expect(headers.get("x-pracht-confirm")).toBeNull();
  });

  it("preserves explicit null input in browser calls", async () => {
    const root = createFixture({ capabilities: { "notes-create.ts": CREATE_CAPABILITY } });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    let requestInit: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return Response.json({ ok: true, data: null });
    }) as typeof fetch;

    try {
      const mod = await importGeneratedModule<{
        callCapability: (name: string, input?: unknown) => Promise<unknown>;
      }>(source);
      await mod.callCapability("notes.create", null);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestInit?.body).toBe("null");
  });

  it("turns valid JSON with an invalid envelope shape into invalid_response", async () => {
    const root = createFixture({ capabilities: { "notes-search.ts": SEARCH_CAPABILITY } });
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    const originalFetch = globalThis.fetch;
    const malformedEnvelopes = [null, { ok: true }, { error: {}, ok: false }];
    globalThis.fetch = (async () => Response.json(malformedEnvelopes.shift())) as typeof fetch;

    try {
      const mod = await importGeneratedModule<{
        callCapability: (name: string, input?: unknown) => Promise<unknown>;
      }>(source);

      for (let index = 0; index < 3; index += 1) {
        await expect(mod.callCapability("notes.search", { query: "roadmap" })).resolves.toEqual({
          error: {
            code: "invalid_response",
            message: "Capability endpoint returned an invalid envelope (status 200).",
          },
          ok: false,
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createPrachtWebmcpModuleSource", () => {
  it("registers one tool per webmcp capability with its input schema", () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY,
        "notes-create.ts": CREATE_CAPABILITY,
      },
    });

    const source = createPrachtWebmcpModuleSource({}, { root });
    expect(source).toContain('"name":"notes.search"');
    expect(source).toContain('"title":"Search notes"');
    expect(source).toContain('"description":"Find notes whose title matches the query."');
    expect(source).toContain('"inputSchema":{"type":"object"');
    expect(source).toContain('"annotations":{"readOnlyHint":true}');
    // notes.create is http-only — it must not become a page tool.
    expect(source).not.toContain('"name":"notes.create"');
    // Targets the standardized API only — Chromium removed the deprecated
    // navigator.modelContext alias in 152.
    expect(source).toContain("document.modelContext");
    expect(source).not.toContain("navigator.modelContext");
    expect(source).toContain("registerTool");
    expect(source).toContain("async execute(input, { signal } = {})");
    expect(source).toContain("signal,");
    // The host serializes the returned value itself; MCP-style content blocks
    // would reach the agent double-encoded.
    expect(source).not.toContain("content:");
  });

  it("advertises untrustedContentHint for expose.webmcp.untrustedContent", () => {
    const root = createFixture({
      capabilities: {
        "notes-search.ts": SEARCH_CAPABILITY.replace(
          "webmcp: true,",
          "webmcp: { untrustedContent: true },",
        ),
      },
    });

    const source = createPrachtWebmcpModuleSource({}, { root });
    expect(source).toContain('"annotations":{"readOnlyHint":true,"untrustedContentHint":true}');
  });
});

describe("client entry integration", () => {
  it("imports the webmcp shim only when a capability opts in", () => {
    const withWebmcp = createFixture({ capabilities: { "notes-search.ts": SEARCH_CAPABILITY } });
    const withoutWebmcp = createFixture({ capabilities: { "notes-create.ts": CREATE_CAPABILITY } });
    const none = createFixture({});

    expect(createPrachtClientModuleSource({}, { root: withWebmcp })).toContain(
      'import("virtual:pracht/webmcp")',
    );
    expect(createPrachtIslandsClientModuleSource({}, { root: withWebmcp })).toContain(
      'import("virtual:pracht/webmcp")',
    );
    expect(createPrachtServerModuleSource({}, { root: withWebmcp })).toContain(
      "export const islandsBootstrapRequired = true;",
    );

    for (const root of [withoutWebmcp, none]) {
      expect(createPrachtClientModuleSource({}, { root })).not.toContain("webmcp");
      expect(createPrachtIslandsClientModuleSource({}, { root })).not.toContain("webmcp");
      expect(createPrachtServerModuleSource({}, { root })).toContain(
        "export const islandsBootstrapRequired = false;",
      );
    }
  });
});
