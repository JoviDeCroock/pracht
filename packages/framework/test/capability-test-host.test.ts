import { afterEach, describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import {
  createCapabilityTestHost,
  setCapabilityAuditHook,
  setCapabilityConfirmationSecret,
} from "../src/index.ts";
import type { CapabilityAuditEvent, PrachtAgentIdentity, PrachtCapability } from "../src/types.ts";

type CapabilityDefinition = Parameters<typeof defineCapability>[0];

const TEST_AGENT: PrachtAgentIdentity = {
  verified: true,
  agentDomain: "test-agent.example",
  keyId: "test-key-id",
};

function createSearchCapability(overrides: Record<string, unknown> = {}): PrachtCapability {
  return defineCapability({
    title: "Search notes",
    description: "Find notes.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
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
    expose: { http: true },
    async run({ input }) {
      const typed = input as { query: string; limit: number };
      return { notes: [`${typed.query}:${typed.limit}`] };
    },
    ...overrides,
  } as CapabilityDefinition) as PrachtCapability;
}

afterEach(() => {
  setCapabilityAuditHook(null);
  setCapabilityConfirmationSecret(null);
});

describe("createCapabilityTestHost — invoke()", () => {
  it("runs the full pipeline: defaults, middleware, run, envelope", async () => {
    const host = createCapabilityTestHost({
      capabilities: {
        "notes.search": createSearchCapability({
          middleware: ["enrich"],
          async run({
            input,
            context,
          }: {
            input: { query: string; limit: number };
            context: Record<string, unknown>;
          }) {
            return { notes: [`${input.query}:${input.limit}:${context.fromMiddleware}`] };
          },
        }),
      },
      middleware: {
        enrich: async (args, next) => {
          (args.context as Record<string, unknown>).fromMiddleware = true;
          return next();
        },
      },
    });

    const result = await host.invoke<{ notes: string[] }>("notes.search", { query: "roadmap" });
    expect(result).toEqual({ ok: true, data: { notes: ["roadmap:10:true"] } });
  });

  it("returns the invalid_input envelope with path-scoped issues", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability() },
    });

    const result = await host.invoke("notes.search", { query: "", limit: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error envelope");
    expect(result.error.code).toBe("invalid_input");
    expect(result.error.issues).toEqual([
      { path: "/query", message: "must be at least 1 character(s) long" },
      { path: "/limit", message: "must be <= 20" },
    ]);
  });

  it("answers unknown names with the unknown_capability envelope", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability() },
    });

    const result = await host.invoke("notes.serach", { query: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error envelope");
    expect(result.error.code).toBe("unknown_capability");
    expect(result.error.message).toContain('Did you mean "notes.search"?');
  });

  it("maps middleware short-circuits to the typed envelope", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability({ middleware: ["deny"] }) },
      middleware: {
        deny: async () => new Response("denied", { status: 401 }),
      },
    });

    const result = await host.invoke("notes.search", { query: "roadmap" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error envelope");
    expect(result.error.code).toBe("unauthorized");
  });

  it("honors a middleware response that replaces the result after next()", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability({ middleware: ["deny-after"] }) },
      middleware: {
        "deny-after": async (_args, next) => {
          await next();
          return new Response("denied", { status: 403 });
        },
      },
    });

    const result = await host.invoke("notes.search", { query: "roadmap" });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "forbidden",
        message: "Capability middleware short-circuited with status 403.",
      },
    });
  });

  it("invokes private capabilities that have no expose at all", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability({ expose: undefined }) },
    });

    const result = await host.invoke("notes.search", { query: "roadmap" });
    expect(result.ok).toBe(true);
  });

  it("emits audit events with the server transport", async () => {
    const events: CapabilityAuditEvent[] = [];
    setCapabilityAuditHook((event) => events.push(event));

    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability() },
    });
    await host.invoke("notes.search", { query: "roadmap" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      capability: "notes.search",
      effect: "read",
      transport: "server",
      outcome: "ok",
      status: 200,
      agent: null,
    });
  });
});

describe("createCapabilityTestHost — request()", () => {
  it("dispatches over the HTTP projection with the ok envelope", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability() },
    });

    const response = await host.request("notes.search", { query: "roadmap" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { notes: ["roadmap:10"] } });
  });

  it("answers invalid input with 400 and path-scoped issues", async () => {
    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability() },
    });

    const response = await host.request("notes.search", { query: "", limit: 99 });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.issues).toHaveLength(2);
  });

  it("answers unregistered and non-http capabilities with the 404 envelope", async () => {
    const host = createCapabilityTestHost({
      capabilities: {
        "notes.search": createSearchCapability(),
        "notes.private": createSearchCapability({ expose: undefined }),
      },
    });

    for (const name of ["notes.missing", "notes.private"]) {
      const response = await host.request(name, { query: "x" });
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("unknown_capability");
    }
  });

  it('enforces agentPolicy "require" and accepts simulated identities', async () => {
    const host = createCapabilityTestHost({
      capabilities: {
        "agent.ping": createSearchCapability({
          agentPolicy: "require",
          async run({ context }: { context: { agent: PrachtAgentIdentity | null } }) {
            return { notes: [context.agent?.agentDomain ?? "none"] };
          },
        }),
      },
    });

    const unsigned = await host.request("agent.ping", { query: "x" });
    expect(unsigned.status).toBe(401);
    expect((await unsigned.json()).error.code).toBe("agent_required");

    const signed = await host.request("agent.ping", { query: "x" }, { agent: TEST_AGENT });
    expect(signed.status).toBe(200);
    expect((await signed.json()).data.notes).toEqual(["test-agent.example"]);
  });

  it("overwrites unverified agent context when Web Bot Auth is configured", async () => {
    const host = createCapabilityTestHost({
      agents: { webBotAuth: { policy: "observe" } },
      capabilities: {
        "agent.ping": createSearchCapability({
          async run({ context }: { context: { agent: PrachtAgentIdentity | null } }) {
            return { notes: [context.agent?.keyId ?? "none"] };
          },
        }),
      },
    });

    const response = await host.request(
      "agent.ping",
      { query: "x" },
      { context: { agent: { ...TEST_AGENT, keyId: "spoofed" } } },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.notes).toEqual(["none"]);
  });

  it("walks the destructive prepare/commit confirmation flow", async () => {
    setCapabilityConfirmationSecret("test-host-secret");
    let purged = 0;
    const host = createCapabilityTestHost({
      capabilities: {
        "notes.purge": createSearchCapability({
          effect: "destructive",
          async run() {
            purged += 1;
            return { notes: [] };
          },
        }),
      },
    });

    // Prepare: no token → 409 with a confirmation token, nothing runs.
    const prepare = await host.request("notes.purge", { query: "old" });
    expect(prepare.status).toBe(409);
    const prepareBody = await prepare.json();
    expect(prepareBody.error.code).toBe("confirmation_required");
    const token = prepareBody.error.confirmationToken as string;
    expect(purged).toBe(0);

    // Tampered token → 403, fail closed.
    const tampered = await host.request(
      "notes.purge",
      { query: "old" },
      { headers: { "x-pracht-confirm": `${token}x` } },
    );
    expect(tampered.status).toBe(403);
    expect(purged).toBe(0);

    // Same token, different input → 403 (token is input-bound).
    const mismatched = await host.request(
      "notes.purge",
      { query: "other" },
      { headers: { "x-pracht-confirm": token } },
    );
    expect(mismatched.status).toBe(403);
    expect(purged).toBe(0);

    // Commit: identical input + token → runs.
    const commit = await host.request(
      "notes.purge",
      { query: "old" },
      { headers: { "x-pracht-confirm": token } },
    );
    expect(commit.status).toBe(200);
    expect(purged).toBe(1);
  });

  it("fails closed when no confirmation secret is configured", async () => {
    const host = createCapabilityTestHost({
      capabilities: {
        "notes.purge": createSearchCapability({ effect: "destructive" }),
      },
    });

    const response = await host.request("notes.purge", { query: "old" });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("confirmation_unavailable");
  });

  it("emits audit events with the http transport and the simulated agent", async () => {
    const events: CapabilityAuditEvent[] = [];
    setCapabilityAuditHook((event) => events.push(event));

    const host = createCapabilityTestHost({
      capabilities: { "notes.search": createSearchCapability() },
    });
    await host.request("notes.search", { query: "roadmap" }, { agent: TEST_AGENT });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      capability: "notes.search",
      transport: "http",
      outcome: "ok",
      agent: TEST_AGENT,
    });
  });
});
