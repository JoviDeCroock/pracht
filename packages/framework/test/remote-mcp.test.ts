import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CAPABILITY_TRANSPORT_HEADER,
  defineCapability,
  findMcpToolNameCollisions,
  isValidMcpToolName,
  mcpToolName,
} from "../../capabilities/src/index.ts";
import {
  defineApp,
  handlePrachtRequest,
  invokeCapability,
  route,
  setCapabilityAuditHook,
} from "../src/index.ts";
import { invokeCapabilityOnHost } from "../src/runtime-capabilities.ts";
import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  resolveMcpEndpoint,
} from "../src/runtime-mcp.ts";
import type { CapabilityAuditEvent, ModuleRegistry, PrachtAgentsConfig } from "../src/types.ts";

const ORIGIN = "https://app.example";

type CapabilityDefinition = Parameters<typeof defineCapability>[0];

const created: string[] = [];
const destroyed: string[] = [];
const observedAgentKeys: string[] = [];
const observedTenants: string[] = [];

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

/** MCP entry point that composes another capability through the request-bound host. */
const notesCompose = defineCapability({
  title: "Compose notes",
  description: "Invoke another notes capability.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
  effect: "read",
  expose: { mcp: true },
  async run({ request, context, signal }) {
    const result = await invokeCapability(
      "notes.internal" as never,
      {},
      { request, context, signal },
    );
    return { count: result.ok ? (result.data as { count: number }).count : -1 };
  },
} as CapabilityDefinition);

/**
 * Composition is server authority, not a way around policy: the composed
 * capability's own named middleware still decides. Pins that seam, since it is
 * where authorization for a nested call has to live.
 */
const notesComposeGuarded = defineCapability({
  title: "Compose guarded notes",
  description: "Invoke a capability that is behind denying middleware.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  effect: "read",
  expose: { mcp: true },
  async run({ request, context, signal }) {
    const result = await invokeCapability(
      "notes.guarded" as never,
      {},
      {
        request,
        context,
        signal,
      },
    );
    return { code: result.ok ? "ok" : result.error.code };
  },
} as CapabilityDefinition);

/** MCP entry point attempting to compose a capability with a stricter agent policy. */
const notesComposeAgentOnly = defineCapability({
  title: "Compose agent-only notes",
  description: "Invoke a capability that requires a verified agent.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  effect: "read",
  expose: { mcp: true },
  async run({ request, signal }) {
    const result = await invokeCapability(
      "agent.only" as never,
      {},
      {
        request,
        // The nested policy must use the identity bound by the MCP transport,
        // not a context value that composing application code can replace.
        context: {
          agent: { verified: true, agentDomain: "forged.example", keyId: "forged" },
        },
        signal,
      },
    );
    return { code: result.ok ? "ok" : result.error.code };
  },
} as CapabilityDefinition);

const notesDestroy = defineCapability({
  title: "Destroy notes",
  description: "Destroy notes permanently.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  effect: "destructive",
  async run() {
    destroyed.push("notes");
    return { ok: true };
  },
} as CapabilityDefinition);

/** Non-destructive MCP entry point attempting to lend reachability to a destructive callee. */
const notesComposeDestructive = defineCapability({
  title: "Compose destructive notes",
  description: "Invoke a destructive capability.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  effect: "read",
  expose: { mcp: true },
  async run({ request, context, signal }) {
    const result = await invokeCapability(
      "notes.destroy" as never,
      {},
      {
        request,
        context,
        signal,
      },
    );
    return { code: result.ok ? "ok" : result.error.code };
  },
} as CapabilityDefinition);

const agentOnly = defineCapability({
  title: "Agent only",
  description: "Requires a verified agent.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
  effect: "read",
  expose: { http: true, mcp: true },
  agentPolicy: "require",
  middleware: ["recordAgent"],
  async run({ context }) {
    return {
      keyId: (context as { agent?: { keyId?: string } }).agent?.keyId ?? "missing",
    };
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

const urlProbe = defineCapability({
  title: "URL probe",
  description: "Reports the URL seen by capability middleware.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: {
      requestPath: { type: "string" },
      urlPath: { type: "string" },
    },
    required: ["requestPath", "urlPath"],
  },
  effect: "read",
  middleware: ["recordUrl"],
  expose: { http: true, mcp: true },
  async run({ context }) {
    return context as { requestPath: string; urlPath: string };
  },
} as CapabilityDefinition);

const jsonShortCircuit = defineCapability({
  title: "JSON short circuit",
  description: "Stops in middleware with non-envelope JSON.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  effect: "read",
  middleware: ["jsonShortCircuit"],
  expose: { mcp: true },
  async run() {
    return { ok: true };
  },
} as CapabilityDefinition);

const invalidOutputShortCircuit = defineCapability({
  title: "Invalid output short circuit",
  description: "Stops in middleware with an invalid success envelope.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  effect: "read",
  middleware: ["invalidOutputShortCircuit"],
  expose: { mcp: true },
  async run() {
    return { ok: true };
  },
} as CapabilityDefinition);

function createApp(agents: PrachtAgentsConfig | undefined) {
  const capabilities = {
    "notes.search": notesSearch,
    "notes.create": notesCreate,
    "notes.compose": notesCompose,
    "notes.compose-guarded": notesComposeGuarded,
    "notes.compose-agent-only": notesComposeAgentOnly,
    "notes.compose-destructive": notesComposeDestructive,
    "notes.destroy": notesDestroy,
    "notes.internal": notesInternal,
    "notes.guarded": guarded,
    "agent.only": agentOnly,
    "auth.probe": authProbe,
    "url.probe": urlProbe,
    "json.short-circuit": jsonShortCircuit,
    "invalid-output.short-circuit": invalidOutputShortCircuit,
  };

  const app = defineApp({
    agents,
    middleware: {
      deny: "./middleware/deny.ts",
      recordAgent: "./middleware/record-agent.ts",
      recordUrl: "./middleware/record-url.ts",
      jsonShortCircuit: "./middleware/json-short-circuit.ts",
      invalidOutputShortCircuit: "./middleware/invalid-output-short-circuit.ts",
    },
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
      "./middleware/record-agent.ts": async () => ({
        middleware: async (
          args: { context: { agent?: { keyId?: string }; tenant?: string } },
          next: () => Promise<Response>,
        ) => {
          observedAgentKeys.push(args.context.agent?.keyId ?? "missing");
          observedTenants.push(args.context.tenant ?? "missing");
          return next();
        },
      }),
      "./middleware/record-url.ts": async () => ({
        middleware: async (
          args: { context: Record<string, unknown>; request: Request; url: URL },
          next: () => Promise<Response>,
        ) => {
          args.context.requestPath = new URL(args.request.url).pathname;
          args.context.urlPath = args.url.pathname;
          return next();
        },
      }),
      "./middleware/json-short-circuit.ts": async () => ({
        middleware: async () => Response.json({ cached: true }),
      }),
      "./middleware/invalid-output-short-circuit.ts": async () => ({
        middleware: async () => Response.json({ ok: true, data: { cached: true } }),
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
  context?: unknown;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  body?: unknown;
  rawBody?: string;
  onCapabilityAudit?: (event: CapabilityAuditEvent) => void;
}

async function mcp(message: unknown, options: McpCallOptions = {}) {
  const { app, registry } = createApp("agents" in options ? options.agents : { mcp: {} });
  const url = `${ORIGIN}${options.path ?? "/mcp"}`;
  const method = options.method ?? "POST";
  const response = await handlePrachtRequest({
    app,
    context: options.context,
    registry,
    request: new Request(url, {
      method,
      headers: { "content-type": "application/json", ...options.headers },
      body:
        method === "GET" ? undefined : (options.rawBody ?? JSON.stringify(options.body ?? message)),
    }),
    onCapabilityAudit: options.onCapabilityAudit,
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
  destroyed.length = 0;
  observedAgentKeys.length = 0;
  observedTenants.length = 0;
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
      { agents: { mcp: { path: "/agent/mcp/" } }, path: "/agent/mcp/" },
    );
    expect(json?.result).toEqual({});
  });

  it("serves the default endpoint with a trailing slash", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { path: "/mcp/" });
    expect(json?.result.tools).toBeDefined();
  });

  it("resolves the endpoint path", () => {
    expect(resolveMcpEndpoint(undefined)).toBeNull();
    expect(resolveMcpEndpoint({ mcp: {} })).toBe("/mcp");
    expect(resolveMcpEndpoint({ mcp: { path: "/agent/mcp/" } })).toBe("/agent/mcp");
  });

  it("serves an empty tool list when the endpoint is configured without capabilities", async () => {
    const app = defineApp({ agents: { mcp: {} }, routes: [] });
    const response = await handlePrachtRequest({
      app,
      registry: { routeModules: {} },
      request: new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: [] } });
  });

  it("keeps registry failures on the MCP protocol surface", async () => {
    const app = defineApp({
      agents: { mcp: {} },
      capabilities: { broken: "./capabilities/broken.ts" },
      routes: [],
    });
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {},
        capabilityModules: {
          "./capabilities/broken.ts": async () => ({ default: {} }) as never,
        },
      },
      request: new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603 },
    });
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

  it("blocks browser requests when Origin matches the Host-derived request URL", async () => {
    const { status, text } = await mcp(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } },
    );
    expect(status).toBe(403);
    expect(text).toContain("Browser-originated requests are not allowed");
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

  it.each([null, true, {}, []])("rejects invalid MCP request ids (%j)", async (id) => {
    const { status, json } = await mcp({ jsonrpc: "2.0", id, method: "ping" });
    expect(status).toBe(400);
    expect(json).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600 },
    });
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
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(known.json?.result.protocolVersion).toBe("2025-06-18");
    expect(known.json?.result.capabilities.tools).toBeDefined();

    const unknown = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "1999-01-01",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(unknown.json?.result.protocolVersion).toBe("2025-11-25");
  });

  it("reports configured server info", async () => {
    const { json } = await mcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      { agents: { mcp: { serverInfo: { name: "notes", version: "1.2.3" }, instructions: "Hi." } } },
    );
    expect(json?.result.serverInfo).toEqual({ name: "notes", version: "1.2.3" });
    expect(json?.result.instructions).toBe("Hi.");
  });

  it.each([
    undefined,
    {},
    { protocolVersion: 7, capabilities: {}, clientInfo: { name: "client", version: "1" } },
    {
      protocolVersion: "2025-11-25",
      capabilities: null,
      clientInfo: { name: "client", version: "1" },
    },
    { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: null },
    { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "", version: "1" } },
  ])("rejects invalid initialize params (%j)", async (params) => {
    const { status, json } = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      ...(params === undefined ? {} : { params }),
    });

    expect(status).toBe(200);
    expect(json?.error).toMatchObject({ code: -32602 });
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
      "invalid-output_short-circuit",
      "json_short-circuit",
      "notes_compose",
      "notes_compose-agent-only",
      "notes_compose-destructive",
      "notes_compose-guarded",
      "notes_create",
      "notes_guarded",
      "notes_search",
      "url_probe",
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
    expect(search.annotations).not.toHaveProperty("openWorldHint");
    expect(search._meta["io.pracht/capability"]).toBe("notes.search");

    const create = json?.result.tools.find(
      (tool: { name: string }) => tool.name === "notes_create",
    );
    expect(create.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(create.annotations).not.toHaveProperty("destructiveHint");
  });

  it("maps dots to underscores and detects collisions", () => {
    expect(mcpToolName("notes.search")).toBe("notes_search");
    expect(isValidMcpToolName("a".repeat(64))).toBe(true);
    expect(isValidMcpToolName("a".repeat(65))).toBe(false);
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

  it("keeps private non-destructive composition available on the synthesized request", async () => {
    const { json } = await callTool("notes_compose", {});
    expect(json?.result).toMatchObject({
      isError: false,
      structuredContent: { count: 1 },
    });
  });

  it("attributes composed dispatches to the mcp transport that caused them", async () => {
    const events: CapabilityAuditEvent[] = [];

    await callTool("notes_compose", {}, { onCapabilityAudit: (event) => events.push(event) });

    // Composition runs the callee's own pipeline only — no HTTP/MCP dispatch
    // guards — so the audit trail is what ties the nested effect back to the
    // remote agent that triggered it.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      capability: "notes.internal",
      transport: "server",
      via: "mcp",
      outcome: "ok",
    });
    expect(events[1]).toMatchObject({
      capability: "notes.compose",
      transport: "mcp",
      via: null,
      outcome: "ok",
    });
  });

  it("still runs the composed capability's named middleware", async () => {
    const events: CapabilityAuditEvent[] = [];

    const { json } = await callTool(
      "notes_compose-guarded",
      {},
      {
        onCapabilityAudit: (event) => events.push(event),
      },
    );

    // The composed capability's own middleware is the seam that authorizes a
    // nested call — the transport gates belong to the incoming dispatch — so
    // composing into a guarded capability is still denied by it.
    expect(json?.result.structuredContent).toEqual({ code: "unauthorized" });
    expect(events.map((event) => [event.capability, event.transport, event.via])).toEqual([
      ["notes.guarded", "server", "mcp"],
      ["notes.compose-guarded", "mcp", null],
    ]);
  });

  it("enforces the composed capability's agentPolicy", async () => {
    const events: CapabilityAuditEvent[] = [];

    const { json } = await callTool(
      "notes_compose-agent-only",
      {},
      {
        onCapabilityAudit: (event) => events.push(event),
      },
    );

    expect(json?.result.structuredContent).toEqual({ code: "agent_required" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      capability: "agent.only",
      transport: "server",
      via: "mcp",
      outcome: "agent_required",
      status: 401,
      agent: null,
    });
    expect(events[1]).toMatchObject({
      capability: "notes.compose-agent-only",
      transport: "mcp",
      outcome: "ok",
    });
    expect(observedAgentKeys).toEqual([]);
  });

  it("binds the verified MCP identity into nested middleware and capability context", async () => {
    const { app, registry } = createApp({
      mcp: {},
      webBotAuth: { policy: "observe" },
    });
    const agent = {
      verified: true as const,
      agentDomain: "verified.example",
      keyId: "verified-key",
    };
    const request = new Request(`${ORIGIN}/__pracht/mcp/tools/composer`, {
      method: "POST",
      body: "{}",
    });
    const immutableContext = Object.freeze({ tenant: "one" });

    const forged = await invokeCapabilityOnHost(
      { app, registry, via: "mcp", agent },
      "agent.only",
      {},
      {
        request,
        context: {
          agent: { verified: true, agentDomain: "forged.example", keyId: "forged-key" },
        },
      },
    );
    const omitted = await invokeCapabilityOnHost(
      { app, registry, via: "mcp", agent },
      "agent.only",
      {},
      { request },
    );
    const immutable = await invokeCapabilityOnHost(
      { app, registry, via: "mcp", agent },
      "agent.only",
      {},
      { request, context: immutableContext },
    );

    expect(forged).toEqual({ ok: true, data: { keyId: "verified-key" } });
    expect(omitted).toEqual({ ok: true, data: { keyId: "verified-key" } });
    expect(immutable).toEqual({ ok: true, data: { keyId: "verified-key" } });
    expect("agent" in immutableContext).toBe(false);
    expect(observedAgentKeys).toEqual(["verified-key", "verified-key", "verified-key"]);
    expect(observedTenants).toEqual(["missing", "missing", "one"]);
  });

  it("refuses destructive capability composition from MCP", async () => {
    const events: CapabilityAuditEvent[] = [];

    const { json } = await callTool(
      "notes_compose-destructive",
      {},
      {
        onCapabilityAudit: (event) => events.push(event),
      },
    );

    expect(json?.result.structuredContent).toEqual({ code: "forbidden" });
    expect(destroyed).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      capability: "notes.destroy",
      effect: "destructive",
      transport: "server",
      via: "mcp",
      outcome: "forbidden",
      status: 403,
    });
    expect(events[1]).toMatchObject({
      capability: "notes.compose-destructive",
      transport: "mcp",
      outcome: "ok",
    });
  });

  it("reports schema violations as tool errors carrying the issues", async () => {
    const { json } = await callTool("notes_search", { query: "" });
    expect(json?.result.isError).toBe(true);
    expect(json?.result.structuredContent).toBeUndefined();
    expect(json?.result._meta["io.pracht/error"].code).toBe("invalid_input");
    expect(json?.result._meta["io.pracht/error"].issues.length).toBeGreaterThan(0);
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

  it.each([null, [], "query", 1, true])(
    "rejects non-object tools/call arguments (%j) before dispatch",
    async (args) => {
      const { json } = await callTool("notes_create", args);
      expect(json?.error.code).toBe(-32602);
      expect(created).toEqual([]);
    },
  );

  it("runs the capability's named middleware", async () => {
    const { json } = await callTool("notes_guarded", {});
    expect(json?.result.isError).toBe(true);
    expect(json?.result._meta["io.pracht/error"].code).toBe("unauthorized");
  });

  it("enforces agentPolicy: require", async () => {
    const { json } = await callTool("agent_only", {});
    expect(json?.result._meta["io.pracht/error"].code).toBe("agent_required");
  });

  it("rejects cookie-bearing requests before they can use cookie-derived context", async () => {
    const { status, text } = await callTool(
      "notes_create",
      { title: "spike" },
      { headers: { cookie: "session=abc" } },
    );
    expect(status).toBe(403);
    expect(text).toContain("Cookie-authenticated requests are not allowed");
    expect(created).toEqual([]);
  });

  it("passes a consistent synthesized capability URL to middleware", async () => {
    const { json } = await callTool("url_probe", {});
    expect(json?.result.structuredContent).toEqual({
      requestPath: "/api/capabilities/url/probe",
      urlPath: "/api/capabilities/url/probe",
    });
  });

  it("serves MCP tools with an immutable adapter context", async () => {
    const context = Object.freeze({ tenant: "one" });
    const { json } = await callTool(
      "url_probe",
      {},
      {
        agents: { mcp: {}, webBotAuth: { policy: "observe" } },
        context,
      },
    );

    expect(json?.result.structuredContent).toMatchObject({
      requestPath: "/api/capabilities/url/probe",
      urlPath: "/api/capabilities/url/probe",
    });
    expect(context).toEqual({ tenant: "one" });
  });

  it("turns non-envelope JSON middleware responses into tool errors", async () => {
    const { json } = await callTool("json_short-circuit", {});
    expect(json?.result).toMatchObject({ isError: true });
    expect(json?.result.structuredContent).toBeUndefined();
    expect(json?.result._meta["io.pracht/error"].code).toBe("middleware_rejected");
  });

  it("revalidates success envelopes returned by middleware", async () => {
    const events: CapabilityAuditEvent[] = [];
    setCapabilityAuditHook((event) => events.push(event));

    const { json } = await callTool("invalid-output_short-circuit", {});
    expect(json?.result).toMatchObject({ isError: true });
    expect(json?.result.structuredContent).toBeUndefined();
    expect(json?.result._meta["io.pracht/error"].code).toBe("invalid_output");
    expect(json?.result._meta["io.pracht/status"]).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      capability: "invalid-output.short-circuit",
      outcome: "invalid_output",
      status: 500,
      transport: "mcp",
    });
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

  it("does not trust an MCP transport marker on the public HTTP endpoint", async () => {
    const events: CapabilityAuditEvent[] = [];
    setCapabilityAuditHook((event) => events.push(event));

    const { status } = await mcp(null, {
      path: "/api/capabilities/notes/search",
      body: { query: "x" },
      headers: { [CAPABILITY_TRANSPORT_HEADER]: "mcp" },
    });

    expect(status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].transport).toBe("http");
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

describe("mcp protocol version header", () => {
  it("reports the negotiated version, not simply the newest supported one", async () => {
    const older = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;
    expect(older).not.toBe(MCP_LATEST_PROTOCOL_VERSION);

    const { response, json } = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: older,
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      },
    });

    expect(json?.result.protocolVersion).toBe(older);
    // A client that initialized at an older version must not be told the
    // connection is speaking a version it never agreed to.
    expect(response.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(older);
  });

  it("echoes the version a later request declares", async () => {
    const older = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;

    const { response } = await mcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { headers: { [MCP_PROTOCOL_VERSION_HEADER]: older } },
    );

    expect(response.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(older);
  });

  it("reports the negotiated version on tools/call, not just the handshake", async () => {
    // The method that actually does work is the one most worth getting right,
    // and it lives outside the request-scoped responder.
    const older = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;

    const { response } = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "notes_search", arguments: { query: "a" } },
      },
      { headers: { [MCP_PROTOCOL_VERSION_HEADER]: older } },
    );

    expect(response.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(older);
  });

  it("reports the negotiated version on a tools/call error", async () => {
    const older = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;

    const { response } = await mcp(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      { headers: { [MCP_PROTOCOL_VERSION_HEADER]: older } },
    );

    expect(response.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(older);
  });

  it("falls back to the newest supported version when none is declared", async () => {
    const { response } = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" });

    expect(response.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });
});
