import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defineCapability,
  findMcpToolNameCollisions,
  mcpToolName,
} from "../../capabilities/src/index.ts";
import { defineApp, handlePrachtRequest, route, setCapabilityAuditHook } from "../src/index.ts";
import { MCP_PROTOCOL_VERSION_HEADER, resolveMcpEndpoint } from "../src/runtime-mcp.ts";
import type { CapabilityAuditEvent, ModuleRegistry, PrachtAgentsConfig } from "../src/types.ts";

const ORIGIN = "https://app.example";

type CapabilityDefinition = Parameters<typeof defineCapability>[0];

const created: string[] = [];

const notesSearch = defineCapability({
  title: "Search notes",
  description: "Find notes by substring.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { notes: { type: "array", items: { type: "string" } } },
    required: ["notes"],
  },
  effect: "read",
  expose: { http: true, mcp: true },
  async run({ input }) {
    const typed = input as { query: string; limit: number };
    return { notes: [`${typed.query}:${typed.limit}`] };
  },
} as CapabilityDefinition);

/** Exposed to MCP only — no public HTTP endpoint at all. */
const notesCreate = defineCapability({
  title: "Create note",
  description: "Create a note.",
  input: {
    type: "object",
    properties: { title: { type: "string", minLength: 1 } },
    required: ["title"],
    additionalProperties: false,
  },
  output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  effect: "write",
  expose: { mcp: true },
  async run({ input, request }) {
    const typed = input as { title: string };
    created.push(`${typed.title}|${request.headers.get("cookie") ?? ""}`);
    return { id: `note-${typed.title}` };
  },
} as CapabilityDefinition);

/** Registered but never exposed: must stay invisible to agents. */
const notesInternal = defineCapability({
  title: "Internal stats",
  description: "Private.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
  effect: "read",
  async run() {
    return { count: 1 };
  },
} as CapabilityDefinition);

const agentOnly = defineCapability({
  title: "Agent only",
  description: "Requires a verified agent.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  effect: "read",
  expose: { http: true, mcp: true },
  agentPolicy: "require",
  async run() {
    return { ok: true };
  },
} as CapabilityDefinition);

const guarded = defineCapability({
  title: "Guarded",
  description: "Behind denying middleware.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  effect: "read",
  middleware: ["deny"],
  expose: { http: true, mcp: true },
  async run() {
    return { ok: true };
  },
} as CapabilityDefinition);

const authProbe = defineCapability({
  title: "Auth probe",
  description: "Reports the Authorization header the handler saw.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: { authorization: { type: "string" } },
    required: ["authorization"],
  },
  effect: "read",
  expose: { mcp: true },
  async run({ request }) {
    return { authorization: request.headers.get("authorization") ?? "" };
  },
} as CapabilityDefinition);

function createApp(agents: PrachtAgentsConfig | undefined) {
  const capabilities = {
    "notes.search": notesSearch,
    "notes.create": notesCreate,
    "notes.internal": notesInternal,
    "notes.guarded": guarded,
    "agent.only": agentOnly,
    "auth.probe": authProbe,
  };

  const app = defineApp({
    agents,
    middleware: { deny: "./middleware/deny.ts" },
    capabilities: Object.fromEntries(
      Object.keys(capabilities).map((name) => [name, `./capabilities/${name}.ts`]),
    ),
    routes: [route("/", "./routes/home.tsx")],
  });

  const registry: ModuleRegistry = {
    routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
    middlewareModules: {
      "./middleware/deny.ts": async () => ({
        middleware: async () => new Response("denied", { status: 401 }),
      }),
    },
    capabilityModules: Object.fromEntries(
      Object.entries(capabilities).map(([name, capability]) => [
        `./capabilities/${name}.ts`,
        async () => ({ default: capability }),
      ]),
    ) as NonNullable<ModuleRegistry["capabilityModules"]>,
  };

  return { app, registry };
}

interface McpCallOptions {
  agents?: PrachtAgentsConfig;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  body?: unknown;
  rawBody?: string;
}

async function mcp(message: unknown, options: McpCallOptions = {}) {
  const { app, registry } = createApp("agents" in options ? options.agents : { mcp: {} });
  const url = `${ORIGIN}${options.path ?? "/mcp"}`;
  const method = options.method ?? "POST";
  const response = await handlePrachtRequest({
    app,
    registry,
    request: new Request(url, {
      method,
      headers: { "content-type": "application/json", ...options.headers },
      body:
        method === "GET" ? undefined : (options.rawBody ?? JSON.stringify(options.body ?? message)),
    }),
  });
  const text = await response.clone().text();
  let json: Record<string, any> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, any>) : null;
  } catch {
    // Transport-level rejections answer with plain text on purpose.
  }
  return { response, status: response.status, text, json };
}

function callTool(name: string, args: unknown, options: McpCallOptions = {}) {
  return mcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    options,
  );
}

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  setCapabilityAuditHook(null);
});

// ---------------------------------------------------------------------------
// Opt-in
// ---------------------------------------------------------------------------

describe("serving is opt-in", () => {
  it("does not serve /mcp without agents.mcp", async () => {
    const { json } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { agents: undefined },
    );
    // Falls through to ordinary routing: no JSON-RPC answer, no tool list.
    expect(json?.jsonrpc).toBeUndefined();
    expect(json?.result).toBeUndefined();
  });

  it("serves a custom path", async () => {
    const { json } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { agents: { mcp: { path: "/agent/mcp" } }, path: "/agent/mcp" },
    );
    expect(json?.result).toEqual({});
  });

  it("resolves the endpoint path", () => {
    expect(resolveMcpEndpoint(undefined)).toBeNull();
    expect(resolveMcpEndpoint({ mcp: {} })).toBe("/mcp");
    expect(resolveMcpEndpoint({ mcp: { path: "/agent/mcp/" } })).toBe("/agent/mcp");
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe("transport", () => {
  it("rejects GET — a stateless server has no stream to open", async () => {
    const { response, status } = await mcp(null, { method: "GET" });
    expect(status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("blocks cross-origin browser requests", async () => {
    const { status } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(status).toBe(403);
  });

  it("serves non-browser callers that send no Origin", async () => {
    const { status, json } = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(status).toBe(200);
    expect(json?.result).toEqual({});
  });

  it("rejects an unsupported protocol version", async () => {
    const { status, json } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { [MCP_PROTOCOL_VERSION_HEADER]: "1999-01-01" } },
    );
    expect(status).toBe(400);
    expect(json?.error.message).toContain("Unsupported MCP protocol version");
  });

  it("rejects a client that cannot accept JSON", async () => {
    const { status } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { accept: "text/html" } },
    );
    expect(status).toBe(406);
  });

  it("rejects malformed JSON and non-JSON-RPC payloads", async () => {
    expect((await mcp(null, { rawBody: "{" })).json?.error.code).toBe(-32700);
    expect((await mcp({ hello: "world" })).json?.error.code).toBe(-32600);
  });

  it("rejects JSON-RPC batches", async () => {
    const { status, json } = await mcp([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(status).toBe(400);
    expect(json?.error.message).toContain("batching");
  });

  it("answers notifications with 202 and no body", async () => {
    const { status, text } = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
    expect(text).toBe("");
  });

  it("reports unknown methods as method-not-found", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(json?.error.code).toBe(-32601);
  });

  it("negotiates the protocol version on initialize", async () => {
    const known = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect(known.json?.result.protocolVersion).toBe("2025-06-18");
    expect(known.json?.result.capabilities.tools).toBeDefined();

    const unknown = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(unknown.json?.result.protocolVersion).toBe("2026-07-28");
  });

  it("reports configured server info", async () => {
    const { json } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { agents: { mcp: { serverInfo: { name: "notes", version: "1.2.3" }, instructions: "Hi." } } },
    );
    expect(json?.result.serverInfo).toEqual({ name: "notes", version: "1.2.3" });
    expect(json?.result.instructions).toBe("Hi.");
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("projects only capabilities that set expose.mcp", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = json?.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual([
      "agent_only",
      "auth_probe",
      "notes_create",
      "notes_guarded",
      "notes_search",
    ]);
    expect(names).not.toContain("notes_internal");
  });

  it("carries the capability's own schemas and effect-derived annotations", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const search = json?.result.tools.find(
      (tool: { name: string }) => tool.name === "notes_search",
    );

    expect(search.title).toBe("Search notes");
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(search.outputSchema.required).toEqual(["notes"]);
    expect(search.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(search._meta["io.pracht/capability"]).toBe("notes.search");

    const create = json?.result.tools.find(
      (tool: { name: string }) => tool.name === "notes_create",
    );
    expect(create.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("maps dots to underscores and detects collisions", () => {
    expect(mcpToolName("notes.search")).toBe("notes_search");
    expect(findMcpToolNameCollisions(["notes.search", "notes_search", "notes.create"])).toEqual([
      { toolName: "notes_search", capabilities: ["notes.search", "notes_search"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

describe("tools/call runs the same pipeline as the HTTP projection", () => {
  it("returns structured content, with schema defaults applied", async () => {
    const { json } = await callTool("notes_search", { query: "hello" });
    expect(json?.result.isError).toBe(false);
    expect(json?.result.structuredContent).toEqual({ notes: ["hello:10"] });
    expect(json?.result.content[0]).toMatchObject({ type: "text" });
  });

  it("serves a capability that has no HTTP endpoint", async () => {
    const { json } = await callTool("notes_create", { title: "spike" });
    expect(json?.result.structuredContent).toEqual({ id: "note-spike" });
  });

  it("reports schema violations as tool errors carrying the issues", async () => {
    const { json } = await callTool("notes_search", { query: "" });
    expect(json?.result.isError).toBe(true);
    expect(json?.result.structuredContent.code).toBe("invalid_input");
    expect(json?.result.structuredContent.issues.length).toBeGreaterThan(0);
  });

  it("treats an unknown tool as a JSON-RPC error, not a tool error", async () => {
    const { json } = await callTool("nope", {});
    expect(json?.error.code).toBe(-32602);
    expect(json?.error.message).toContain("Unknown tool");
  });

  it("rejects a tools/call without a tool name", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect(json?.error.code).toBe(-32602);
  });

  it("runs the capability's named middleware", async () => {
    const { json } = await callTool("notes_guarded", {});
    expect(json?.result.isError).toBe(true);
    expect(json?.result.structuredContent.code).toBe("unauthorized");
  });

  it("enforces agentPolicy: require", async () => {
    const { json } = await callTool("agent_only", {});
    expect(json?.result.structuredContent.code).toBe("agent_required");
  });

  it("never forwards cookies to the capability", async () => {
    await callTool("notes_create", { title: "spike" }, { headers: { cookie: "session=abc" } });
    // A browser session cookie must not authenticate the remote agent
    // transport, so the projection drops it structurally.
    expect(created).toEqual(["spike|"]);
  });

  it("forwards Authorization so middleware sees the MCP credential", async () => {
    const { json } = await callTool(
      "auth_probe",
      {},
      { headers: { authorization: "Bearer mcp-token" } },
    );
    expect(json?.result.structuredContent).toEqual({ authorization: "Bearer mcp-token" });
  });

  it("audits the call as the mcp transport", async () => {
    const events: CapabilityAuditEvent[] = [];
    setCapabilityAuditHook((event) => events.push(event));

    await callTool("notes_search", { query: "x" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      capability: "notes.search",
      effect: "read",
      outcome: "ok",
      transport: "mcp",
    });
  });
});

// ---------------------------------------------------------------------------
// Destructive capabilities
// ---------------------------------------------------------------------------

describe("destructive capabilities stay off the MCP surface", () => {
  it("is rejected at definition time", () => {
    expect(() =>
      defineCapability({
        title: "Purge",
        description: "Delete everything.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: { type: "object", properties: {}, additionalProperties: false },
        effect: "destructive",
        expose: { http: true, mcp: true },
        async run() {
          return {};
        },
      } as CapabilityDefinition),
    ).toThrow(/agent projections/);
  });

  it("is filtered from the tool list even if one reaches the registry", async () => {
    const { mcpExposedCapabilities } = await import("../src/runtime-mcp.ts");
    const smuggled = {
      name: "notes.purge",
      file: "./capabilities/notes-purge.ts",
      httpPath: "/api/capabilities/notes/purge",
      middlewareFiles: [],
      capability: { effect: "destructive", expose: { http: null, mcp: true, webmcp: false } },
    };

    expect(mcpExposedCapabilities([smuggled as never])).toEqual([]);
  });
});
