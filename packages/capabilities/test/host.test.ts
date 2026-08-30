import { afterEach, describe, expect, it, vi } from "vitest";

import { defineCapability } from "../src/index.ts";
import {
  createCapabilityHost,
  createMemoryApprovalStore,
  setCapabilityApprovalStore,
  setCapabilityConfirmationSecret,
} from "../src/server/index.ts";
import type { MiddlewareFn } from "../src/server/index.ts";

const ORIGIN = "https://app.example";

function searchCapability(overrides: Record<string, unknown> = {}) {
  return defineCapability({
    title: "Search notes",
    description: "Find notes whose title matches the query.",
    input: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { notes: { type: "array", items: { type: "string" } } },
      required: ["notes"],
    },
    effect: "read",
    expose: { http: true },
    async run({ input }) {
      return { notes: [`match:${(input as { query: string }).query}`] };
    },
    ...overrides,
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function mcpCall(name: string, args: unknown, meta?: Record<string, unknown>): Request {
  return post("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });
}

afterEach(() => {
  setCapabilityConfirmationSecret(null);
  setCapabilityApprovalStore(null);
});

describe("createCapabilityHost HTTP dispatch", () => {
  it("serves an exposed capability at its generated endpoint", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
    });

    const response = await host.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, data: { notes: ["match:a"] } });
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("resolves null for URLs outside the capability surface", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
    });

    await expect(host.fetch(new Request(`${ORIGIN}/about`))).resolves.toBeNull();
  });

  it("answers the typed 404 under the capability prefix", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
    });

    const response = await host.fetch(post("/api/capabilities/notes/create", {}));
    expect(response?.status).toBe(404);
    const envelope = (await response?.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("unknown_capability");
  });

  it("validates input through the standard pipeline", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
    });

    const response = await host.fetch(post("/api/capabilities/notes/search", { query: "" }));
    expect(response?.status).toBe(400);
    const envelope = (await response?.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("invalid_input");
  });

  it("rejects cross-origin browser posts by default", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
    });

    const response = await host.fetch(
      post("/api/capabilities/notes/search", { query: "a" }, { origin: "https://evil.example" }),
    );
    expect(response?.status).toBe(403);
    const envelope = (await response?.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("cross_origin_blocked");
  });

  it("serves custom expose.http paths", async () => {
    const host = createCapabilityHost({
      capabilities: {
        "notes.search": searchCapability({ expose: { http: { path: "/agents/search" } } }),
      },
    });

    const response = await host.fetch(post("/agents/search", { query: "a" }));
    expect(response?.status).toBe(200);
  });

  it("runs named middleware and lets it short-circuit", async () => {
    const auth: MiddlewareFn = async (args, next) => {
      if (args.request.headers.get("x-key") !== "secret") {
        return new Response("nope", { status: 401 });
      }
      return next();
    };
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability({ middleware: ["auth"] }) },
      middleware: { auth },
    });

    const denied = await host.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    expect(denied?.status).toBe(401);
    const envelope = (await denied?.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("unauthorized");

    const allowed = await host.fetch(
      post("/api/capabilities/notes/search", { query: "a" }, { "x-key": "secret" }),
    );
    expect(allowed?.status).toBe(200);
  });

  it("passes createContext output to run()", async () => {
    const seen: unknown[] = [];
    const host = createCapabilityHost<{ tenant: string }>({
      capabilities: {
        "notes.search": searchCapability({
          async run({ context }: { context: { tenant: string } }) {
            seen.push(context.tenant);
            return { notes: [] };
          },
        }),
      },
      createContext: (request) => ({ tenant: new URL(request.url).hostname }),
    });

    await host.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    expect(seen).toEqual(["app.example"]);
  });

  it("redacts internal errors unless exposeErrors is set", async () => {
    const boom = searchCapability({
      async run() {
        throw new Error("db exploded");
      },
    });

    const redacting = createCapabilityHost({ capabilities: { "notes.search": boom } });
    const redacted = await redacting.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    const redactedEnvelope = (await redacted?.json()) as { error: { message: string } };
    expect(redactedEnvelope.error.message).not.toContain("db exploded");

    const exposing = createCapabilityHost({
      capabilities: { "notes.search": boom },
      exposeErrors: true,
    });
    const exposed = await exposing.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    const exposedEnvelope = (await exposed?.json()) as { error: { message: string } };
    expect(exposedEnvelope.error.message).toContain("db exploded");
  });

  it("emits audit events with the http transport", async () => {
    const events: { capability: string; transport: string; outcome: string }[] = [];
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
      onAudit: (event) => events.push(event),
    });

    await host.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    expect(events).toEqual([
      expect.objectContaining({ capability: "notes.search", transport: "http", outcome: "ok" }),
    ]);
  });
});

describe("createCapabilityHost invoke()", () => {
  it("invokes private capabilities directly", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability({ expose: undefined }) },
    });

    await expect(host.invoke("notes.search", { query: "a" })).resolves.toEqual({
      ok: true,
      data: { notes: ["match:a"] },
    });
  });

  it("answers unknown names with the typed envelope", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
    });

    const envelope = await host.invoke("notes.creat", {});
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("unknown_capability");
  });
});

describe("createCapabilityHost remote MCP", () => {
  const mcpHost = () =>
    createCapabilityHost({
      capabilities: {
        "notes.search": searchCapability({ expose: { http: true, mcp: true } }),
      },
      agents: { mcp: { serverInfo: { name: "standalone-test", version: "1.0.0" } } },
    });

  it("reports the endpoint path", () => {
    expect(mcpHost().mcpPath).toBe("/mcp");
    expect(
      createCapabilityHost({ capabilities: { "notes.search": searchCapability() } }).mcpPath,
    ).toBeNull();
  });

  it("answers initialize and tools/list", async () => {
    const host = mcpHost();

    const init = await host.fetch(
      post("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    );
    expect(init?.status).toBe(200);
    const initBody = (await init?.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("standalone-test");

    const list = await host.fetch(post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const listBody = (await list?.json()) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["notes_search"]);
  });

  it("dispatches tools/call through the capability pipeline", async () => {
    const response = await mcpHost().fetch(mcpCall("notes_search", { query: "a" }));
    const body = (await response?.json()) as {
      result: { isError: boolean; structuredContent: unknown };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({ notes: ["match:a"] });
  });

  it("rejects browser provenance and ambient cookies at the transport boundary", async () => {
    const withOrigin = await mcpHost().fetch(
      post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: ORIGIN }),
    );
    expect(withOrigin?.status).toBe(403);

    const withCookie = await mcpHost().fetch(
      post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { cookie: "sid=1" }),
    );
    expect(withCookie?.status).toBe(403);
  });

  it("keeps capabilities without expose.mcp off the tool list", async () => {
    const host = createCapabilityHost({
      capabilities: { "notes.search": searchCapability() },
      agents: { mcp: {} },
    });

    const list = await host.fetch(post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const body = (await list?.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toEqual([]);
  });

  it("runs the prepare/commit flow for destructive tools with a store", async () => {
    setCapabilityConfirmationSecret("host-test-secret");
    setCapabilityApprovalStore(createMemoryApprovalStore());

    const destroy = defineCapability({
      title: "Delete note",
      description: "Deletes one note permanently.",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { deleted: { type: "boolean" } },
        required: ["deleted"],
      },
      effect: "destructive",
      expose: { http: true, mcp: true },
      async run() {
        return { deleted: true };
      },
    });

    const host = createCapabilityHost({
      capabilities: { "notes.delete": destroy },
      agents: { mcp: { destructive: true } },
    });

    const prepare = await host.fetch(mcpCall("notes_delete", { id: "n1" }));
    const prepareBody = (await prepare?.json()) as {
      result: { isError: boolean; _meta: Record<string, unknown> };
    };
    expect(prepareBody.result.isError).toBe(true);
    const errorMeta = prepareBody.result._meta["io.pracht/error"] as {
      code: string;
      confirmationToken: string;
    };
    expect(errorMeta.code).toBe("confirmation_required");
    expect(errorMeta.confirmationToken).toBeTruthy();

    const commit = await host.fetch(
      mcpCall(
        "notes_delete",
        { id: "n1" },
        { "io.pracht/confirmation": errorMeta.confirmationToken },
      ),
    );
    const commitBody = (await commit?.json()) as {
      result: { isError: boolean; structuredContent: unknown };
    };
    expect(commitBody.result.isError).toBe(false);
    expect(commitBody.result.structuredContent).toEqual({ deleted: true });

    // The store makes commits exactly-once: replaying the same token fails.
    const replay = await host.fetch(
      mcpCall(
        "notes_delete",
        { id: "n1" },
        { "io.pracht/confirmation": errorMeta.confirmationToken },
      ),
    );
    const replayBody = (await replay?.json()) as { result: { isError: boolean } };
    expect(replayBody.result.isError).toBe(true);
  });
});

describe("createCapabilityHost OAuth resource server", () => {
  const authHost = (verify: (token: string) => { subject: string } | null) =>
    createCapabilityHost({
      capabilities: {
        "notes.search": searchCapability({ expose: { http: true, mcp: true } }),
      },
      agents: {
        mcp: {
          auth: {
            resource: `${ORIGIN}/mcp`,
            authorizationServers: ["https://auth.example"],
            verify: async (token) => verify(token),
          },
        },
      },
    });

  it("serves the RFC 9728 metadata document", async () => {
    const host = authHost(() => null);
    const response = await host.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: ["https://auth.example"],
    });
  });

  it("challenges unauthenticated MCP calls and admits verified tokens", async () => {
    const host = authHost((token) => (token === "good" ? { subject: "user-1" } : null));

    const denied = await host.fetch(post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(denied?.status).toBe(401);
    expect(denied?.headers.get("www-authenticate")).toContain("resource_metadata=");

    const allowed = await host.fetch(
      post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer good" }),
    );
    expect(allowed?.status).toBe(200);
  });
});

describe("createCapabilityHost agent policy", () => {
  it("fails closed on agentPolicy require without a verified signature", async () => {
    const host = createCapabilityHost({
      capabilities: {
        "notes.search": searchCapability({ agentPolicy: "require" }),
      },
      agents: { webBotAuth: {} },
    });

    const response = await host.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    expect(response?.status).toBe(401);
    const envelope = (await response?.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("agent_required");
  });
});

describe("createCapabilityHost registration errors", () => {
  it("fails closed when a capability definition is broken", async () => {
    const host = createCapabilityHost({
      capabilities: {
        "notes.search": { kind: "not-a-capability" } as never,
      },
    });

    const response = await host.fetch(post("/api/capabilities/notes/search", { query: "a" }));
    expect(response?.status).toBe(500);
    const envelope = (await response?.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("internal_error");
  });

  it("rejects unknown apiMiddleware names at construction", () => {
    expect(() =>
      createCapabilityHost({
        capabilities: { "notes.search": searchCapability() },
        apiMiddleware: ["missing"],
      }),
    ).toThrow(/Unknown middleware "missing"/);
  });
});

describe("createCapabilityHost composition", () => {
  it("lets run() compose other capabilities via the bound host", async () => {
    vi.useRealTimers();
    const inner = searchCapability({ expose: undefined });
    const outerHost = createCapabilityHost({
      capabilities: {
        "notes.search": inner,
        "notes.wrapped": defineCapability({
          title: "Wrapped search",
          description: "Search through composition.",
          input: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 } },
            required: ["query"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: { notes: { type: "array", items: { type: "string" } } },
            required: ["notes"],
          },
          effect: "read",
          expose: { http: true },
          async run({ input, request }) {
            const { invokeCapability } = await import("../src/server/index.ts");
            const nested = await invokeCapability<{ notes: string[] }>("notes.search", input, {
              request,
            });
            if (!nested.ok) throw new Error(nested.error.message);
            return nested.data;
          },
        }),
      },
    });

    const response = await outerHost.fetch(post("/api/capabilities/notes/wrapped", { query: "a" }));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, data: { notes: ["match:a"] } });
  });
});
