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
});

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
    expect(source).toContain(
      '"notes.search":{"method":"POST","path":"/api/capabilities/notes/search"}',
    );
    expect(source).toContain('"notes.create":{"method":"POST","path":"/api/create-note"}');
    expect(source).not.toContain("notes.private");
    expect(source).not.toContain("defineCapability");
    expect(source).toContain("export async function callCapability");
  });

  it("emits an empty endpoint map for apps without capabilities", () => {
    const root = createFixture({});
    const source = createPrachtCapabilitiesClientModuleSource({}, { root });
    expect(source).toContain("const endpoints = {};");
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
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}`;
      const mod = (await import(moduleUrl)) as {
        callCapability: (
          name: string,
          input?: unknown,
          opts?: { headers?: HeadersInit },
        ) => Promise<unknown>;
      };
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
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}`;
      const mod = (await import(moduleUrl)) as {
        callCapability: (name: string, input?: unknown) => Promise<unknown>;
      };
      await mod.callCapability("notes.create", null);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestInit?.body).toBe("null");
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
    expect(source).toContain('"description":"Find notes whose title matches the query."');
    expect(source).toContain('"inputSchema":{"type":"object"');
    // notes.create is http-only — it must not become a page tool.
    expect(source).not.toContain('"name":"notes.create"');
    // Targets the origin-trial API with the deprecated fallback.
    expect(source).toContain("document.modelContext");
    expect(source).toContain("navigator.modelContext");
    expect(source).toContain("registerTool");
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

    for (const root of [withoutWebmcp, none]) {
      expect(createPrachtClientModuleSource({}, { root })).not.toContain("webmcp");
      expect(createPrachtIslandsClientModuleSource({}, { root })).not.toContain("webmcp");
    }
  });
});
