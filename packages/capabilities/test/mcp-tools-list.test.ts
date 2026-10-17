import { describe, expect, it } from "vitest";

import { defineCapability } from "../src/index.ts";
import { createCapabilityHost, type CapabilityHostAgentsConfig } from "../src/server/index.ts";
import type { PrachtCapability } from "../src/server/index.ts";

const ORIGIN = "https://app.example";

function tool(overrides: Record<string, unknown> = {}): PrachtCapability {
  return defineCapability({
    title: "Echo",
    description: "Echo the query.",
    input: { type: "object", properties: { q: { type: "string" } } },
    output: { type: "object", properties: { q: { type: "string" } } },
    effect: "read",
    expose: { mcp: true },
    async run({ input }) {
      return { q: (input as { q?: string }).q ?? "" };
    },
    ...overrides,
  }) as PrachtCapability;
}

function graph(count: number): Record<string, PrachtCapability> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `tools.t${String(index).padStart(3, "0")}`,
      tool(),
    ]),
  );
}

function rpc(method: string, params?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function send(
  host: ReturnType<typeof createCapabilityHost>,
  request: Request,
): Promise<{ status: number; body: Record<string, any>; response: Response }> {
  const response = (await host.fetch(request))!;
  return { status: response.status, body: await response.clone().json(), response };
}

const AUTH = {
  resource: `${ORIGIN}/mcp`,
  authorizationServers: ["https://auth.example"],
  scopesSupported: ["notes.read", "notes.write"],
  async verify(token: string) {
    return {
      subject: "user-1",
      scopes: token === "writer" ? ["notes.read", "notes.write"] : ["notes.read"],
    };
  },
};

describe("tools/list pagination", () => {
  it("returns a small graph in one page with no cursor", async () => {
    const host = createCapabilityHost({ capabilities: graph(3), agents: { mcp: {} } });
    const { body } = await send(host, rpc("tools/list"));
    expect(body.result.tools).toHaveLength(3);
    expect(body.result).not.toHaveProperty("nextCursor");
  });

  it("pages a large graph and visits every tool exactly once", async () => {
    const host = createCapabilityHost({ capabilities: graph(250), agents: { mcp: {} } });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { body } = await send(host, rpc("tools/list", cursor ? { cursor } : undefined));
      expect(body.error).toBeUndefined();
      seen.push(...body.result.tools.map((entry: { name: string }) => entry.name));
      cursor = body.result.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(seen[0]).toBe("tools_t000");
    expect(seen[249]).toBe("tools_t249");
  });

  it("honours agents.mcp.pageSize", async () => {
    const host = createCapabilityHost({
      capabilities: graph(5),
      agents: { mcp: { pageSize: 2 } },
    });
    const first = await send(host, rpc("tools/list"));
    expect(first.body.result.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "tools_t000",
      "tools_t001",
    ]);
    const second = await send(host, rpc("tools/list", { cursor: first.body.result.nextCursor }));
    expect(second.body.result.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "tools_t002",
      "tools_t003",
    ]);
    const third = await send(host, rpc("tools/list", { cursor: second.body.result.nextCursor }));
    expect(third.body.result.tools).toHaveLength(1);
    expect(third.body.result).not.toHaveProperty("nextCursor");
  });

  it.each(["abc", "!!", "", 42, { at: 1 }])(
    "rejects an invalid cursor (%j) with invalid params",
    async (cursor) => {
      const host = createCapabilityHost({ capabilities: graph(3), agents: { mcp: {} } });
      const { status, body } = await send(host, rpc("tools/list", { cursor }));
      expect(status).toBe(200);
      expect(body.error).toMatchObject({ code: -32602 });
    },
  );

  it("rejects pageSize values that are not positive integers", () => {
    for (const pageSize of [0, -1, 1.5, "10"]) {
      expect(
        () =>
          createCapabilityHost({
            capabilities: graph(1),
            agents: { mcp: { pageSize } } as unknown as CapabilityHostAgentsConfig,
          }).mcpPath,
      ).toThrow(/pageSize.* must be a positive integer/);
    }
  });
});

describe("tools/call reuses the projected graph", () => {
  it("does not re-derive every tool on each call", async () => {
    let exposeReads = 0;
    const bystander = tool();
    const counted = new Proxy(bystander, {
      get(target, key, receiver) {
        if (key === "expose") exposeReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const host = createCapabilityHost({
      capabilities: { "notes.called": tool(), "notes.bystander": counted },
      agents: { mcp: {} },
    });

    await send(host, rpc("tools/call", { name: "notes_called", arguments: { q: "a" } }));
    const afterFirst = exposeReads;
    for (let index = 0; index < 5; index++) {
      const { body } = await send(
        host,
        rpc("tools/call", { name: "notes_called", arguments: { q: "a" } }),
      );
      expect(body.result.structuredContent).toEqual({ q: "a" });
    }
    expect(exposeReads).toBe(afterFirst);
  });
});

describe("scoped MCP tools", () => {
  const capabilities = () => ({
    "notes.search": tool(),
    "notes.purge": tool({
      effect: "write",
      expose: { mcp: { scopes: ["notes.write"] } },
    }),
  });
  const agents: CapabilityHostAgentsConfig = { mcp: { auth: AUTH } };

  it("normalizes the object form", () => {
    const capability = tool({ expose: { mcp: { scopes: ["notes.write", "notes.write"] } } });
    expect(capability.expose).toMatchObject({ mcp: true, mcpScopes: ["notes.write"] });
    expect(tool({ expose: { mcp: {} } }).expose).toEqual({
      http: null,
      mcp: true,
      webmcp: false,
      webmcpUntrustedContent: false,
    });
    expect(() => tool({ expose: { mcp: { scopes: ['bad"scope'] } } })).toThrow(/OAuth scope/);
    expect(() => tool({ expose: { mcp: { scopes: "notes.write" } } })).toThrow(/OAuth scope/);
  });

  it("lists a scoped tool only to a token that carries its scopes", async () => {
    const host = createCapabilityHost({ capabilities: capabilities(), agents });
    const reader = await send(
      host,
      rpc("tools/list", undefined, { authorization: "Bearer reader" }),
    );
    expect(reader.body.result.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "notes_search",
    ]);
    const writer = await send(
      host,
      rpc("tools/list", undefined, { authorization: "Bearer writer" }),
    );
    expect(writer.body.result.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "notes_search",
      "notes_purge",
    ]);
  });

  it("answers a call without the scope with an insufficient_scope challenge", async () => {
    const host = createCapabilityHost({ capabilities: capabilities(), agents });
    const denied = await send(
      host,
      rpc("tools/call", { name: "notes_purge", arguments: {} }, { authorization: "Bearer reader" }),
    );
    expect(denied.status).toBe(403);
    expect(denied.response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(denied.response.headers.get("www-authenticate")).toContain('scope="notes.write"');

    const allowed = await send(
      host,
      rpc(
        "tools/call",
        { name: "notes_purge", arguments: { q: "x" } },
        { authorization: "Bearer writer" },
      ),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.result.structuredContent).toEqual({ q: "x" });
  });

  it("never serves a scoped tool from an endpoint without OAuth", async () => {
    const host = createCapabilityHost({ capabilities: capabilities(), agents: { mcp: {} } });
    const list = await send(host, rpc("tools/list"));
    expect(list.body.result.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "notes_search",
    ]);
    const call = await send(host, rpc("tools/call", { name: "notes_purge", arguments: {} }));
    expect(call.body.error).toMatchObject({ code: -32602 });
    expect(call.body.error.message).not.toContain("notes_purge,");
  });
});
