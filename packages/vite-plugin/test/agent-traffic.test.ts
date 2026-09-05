import { describe, expect, it } from "vitest";

import { AGENT_TRAFFIC_LIMIT, createAgentTrafficBuffer } from "../src/agent-traffic.ts";

function auditEvent(overrides: Record<string, unknown> = {}) {
  return {
    capability: "notes.search",
    effect: "read",
    transport: "http",
    via: null,
    outcome: "ok",
    status: 200,
    durationMs: 3,
    agent: null,
    ...overrides,
  } as Parameters<ReturnType<typeof createAgentTrafficBuffer>["record"]>[0];
}

describe("createAgentTrafficBuffer", () => {
  it("records dispatches newest first", () => {
    const buffer = createAgentTrafficBuffer();
    buffer.record(auditEvent({ capability: "notes.search" }));
    buffer.record(auditEvent({ capability: "notes.create", effect: "write" }));

    const snapshot = buffer.snapshot();
    expect(snapshot.events.map((event) => event.capability)).toEqual([
      "notes.create",
      "notes.search",
    ]);
    expect(snapshot.recorded).toBe(2);
    expect(snapshot.limit).toBe(AGENT_TRAFFIC_LIMIT);
    expect(snapshot.events[0].at).toBeGreaterThan(0);
  });

  it("bounds the buffer and keeps the total count of what it dropped", () => {
    const buffer = createAgentTrafficBuffer(3);
    for (let index = 0; index < 10; index += 1) {
      buffer.record(auditEvent({ capability: `notes.${index}` }));
    }

    const snapshot = buffer.snapshot();
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.map((event) => event.capability)).toEqual([
      "notes.9",
      "notes.8",
      "notes.7",
    ]);
    // The counter survives eviction, so the panel can say "3 of 10 shown".
    expect(snapshot.recorded).toBe(10);
    expect(snapshot.limit).toBe(3);
  });

  it("clamps a nonsensical capacity instead of silently dropping everything", () => {
    const buffer = createAgentTrafficBuffer(0);
    buffer.record(auditEvent());
    expect(buffer.snapshot().events).toHaveLength(1);
    expect(buffer.snapshot().limit).toBe(1);
  });

  it("carries transport, via, outcome, status, duration and agent identity", () => {
    const buffer = createAgentTrafficBuffer();
    buffer.record(
      auditEvent({
        capability: "notes.purge",
        effect: "destructive",
        transport: "server",
        via: "mcp",
        outcome: "confirmation_required",
        status: 409,
        durationMs: 12.5,
        agent: { agentDomain: "agent.example", keyId: "abc" },
      }),
    );

    expect(buffer.snapshot().events[0]).toMatchObject({
      capability: "notes.purge",
      effect: "destructive",
      transport: "server",
      via: "mcp",
      outcome: "confirmation_required",
      status: 409,
      durationMs: 12.5,
      agent: { agentDomain: "agent.example", keyId: "abc" },
    });
  });

  it("copies the agent identity rather than retaining the request-scoped object", () => {
    const buffer = createAgentTrafficBuffer();
    const agent = { agentDomain: "agent.example", keyId: "abc" };
    buffer.record(auditEvent({ agent }));

    expect(buffer.snapshot().events[0].agent).not.toBe(agent);
    expect(buffer.snapshot().events[0].agent).toEqual(agent);
  });

  it("survives being detached from its object (it is passed as a bare callback)", () => {
    const buffer = createAgentTrafficBuffer();
    const record = buffer.record;
    record(auditEvent());
    expect(buffer.snapshot().recorded).toBe(1);
  });
});

it("retains only a copied account summary in the devtools buffer", () => {
  const buffer = createAgentTrafficBuffer();
  const tokenAuth = { subject: "user-1", clientId: "client-1", claims: { private: true } };
  buffer.record(auditEvent({ tokenAuth }));
  tokenAuth.subject = "changed";
  expect(buffer.snapshot().events[0].tokenAuth).toEqual({
    subject: "user-1",
    clientId: "client-1",
  });
});
