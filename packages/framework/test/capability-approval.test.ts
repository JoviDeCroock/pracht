import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import {
  createCapabilityTestHost,
  createMemoryApprovalStore,
  setCapabilityApprovalStore,
} from "../src/index.ts";
import {
  clearConsumedConfirmationTokens,
  setCapabilityConfirmationSecret,
} from "../src/runtime-confirmation.ts";
import type {
  CapabilityApprovalConsumeResult,
  CapabilityApprovalRecord,
  CapabilityApprovalStore,
  CapabilityEnvelope,
  PrachtAgentsConfig,
} from "../src/types.ts";

const SECRET = "unit-test-confirmation-secret";

let purged: string[] = [];

const purge = defineCapability({
  title: "Purge notes",
  description: "Delete notes by title prefix.",
  input: {
    type: "object",
    properties: { titlePrefix: { type: "string", minLength: 1 } },
    required: ["titlePrefix"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { purged: { type: "integer" } },
    required: ["purged"],
  },
  effect: "destructive",
  expose: { http: true },
  async run({ input }) {
    purged.push((input as { titlePrefix: string }).titlePrefix);
    return { purged: purged.length };
  },
});

function createHost(agents?: PrachtAgentsConfig) {
  return createCapabilityTestHost({ capabilities: { "notes.purge": purge }, agents });
}

async function envelopeOf(response: Response): Promise<CapabilityEnvelope> {
  return (await response.json()) as CapabilityEnvelope;
}

/** Prepare, returning the confirmation token and the proposal id. */
async function prepare(
  host: ReturnType<typeof createHost>,
  input: unknown = { titlePrefix: "Old" },
): Promise<{ token: string; approvalId?: string }> {
  const envelope = await envelopeOf(await host.request("notes.purge", input));
  if (envelope.ok) throw new Error("prepare should not have run the capability");
  return { token: envelope.error.confirmationToken!, approvalId: envelope.error.approvalId };
}

function commit(
  host: ReturnType<typeof createHost>,
  token: string,
  input: unknown = { titlePrefix: "Old" },
) {
  return host.request("notes.purge", input, { headers: { "x-pracht-confirm": token } });
}

beforeEach(() => {
  purged = [];
  setCapabilityConfirmationSecret(SECRET);
});

afterEach(() => {
  setCapabilityConfirmationSecret(null);
  setCapabilityApprovalStore(null);
  clearConsumedConfirmationTokens();
});

// ---------------------------------------------------------------------------
// Store semantics
// ---------------------------------------------------------------------------

describe("createMemoryApprovalStore", () => {
  const record = (overrides: Partial<CapabilityApprovalRecord> = {}): CapabilityApprovalRecord => ({
    id: "proposal-1",
    principal: "anonymous",
    capability: "notes.purge",
    inputHash: "hash",
    input: { titlePrefix: "Old" },
    createdAt: 1_000_000,
    expiresAt: 1_000_120,
    state: "pending",
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  });

  it("is idempotent on create so re-preparing cannot extend a proposal", async () => {
    let clock = 1_000_000;
    const store = createMemoryApprovalStore({ now: () => clock });
    await store.create(record());

    clock += 60;
    const again = await store.create(record({ expiresAt: clock + 120 }));

    expect(again.expiresAt).toBe(1_000_120);
    expect(await store.listPending()).toHaveLength(1);
  });

  it("consumes exactly once under concurrency", async () => {
    const store = createMemoryApprovalStore({ now: () => 1_000_000 });
    await store.create(record());

    const results = await Promise.all([
      store.consume("proposal-1", { requireApproval: false }),
      store.consume("proposal-1", { requireApproval: false }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "already_used" });
  });

  it("reports why a consume failed", async () => {
    let clock = 1_000_000;
    const store = createMemoryApprovalStore({ now: () => clock });

    expect(await store.consume("nope", { requireApproval: false })).toEqual({
      ok: false,
      reason: "unknown",
    });

    await store.create(record());
    expect(await store.consume("proposal-1", { requireApproval: true })).toEqual({
      ok: false,
      reason: "awaiting_approval",
    });

    await store.decide("proposal-1", "rejected", "reviewer");
    expect(await store.consume("proposal-1", { requireApproval: false })).toEqual({
      ok: false,
      reason: "rejected",
    });

    await store.create(record({ id: "proposal-2" }));
    clock += 200;
    expect(await store.consume("proposal-2", { requireApproval: false })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses to decide unknown, expired, or already-decided proposals", async () => {
    let clock = 1_000_000;
    const store = createMemoryApprovalStore({ now: () => clock });
    await store.create(record());

    expect(await store.decide("nope", "approved", "reviewer")).toBe(false);
    expect(await store.decide("proposal-1", "approved", "reviewer")).toBe(true);
    expect(await store.decide("proposal-1", "rejected", "reviewer")).toBe(false);
    expect(await store.get("proposal-1")).toMatchObject({
      state: "approved",
      decidedBy: "reviewer",
      decidedAt: 1_000_000,
    });

    await store.create(record({ id: "proposal-2" }));
    clock += 200;
    expect(await store.decide("proposal-2", "approved", "reviewer")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// token mode
// ---------------------------------------------------------------------------

describe("token mode with an approval store", () => {
  it("commits once and rejects the replay", async () => {
    setCapabilityApprovalStore(createMemoryApprovalStore());
    const host = createHost();

    const { token, approvalId } = await prepare(host);
    expect(approvalId).toBeTypeOf("string");

    expect((await commit(host, token)).status).toBe(200);
    expect(purged).toEqual(["Old"]);

    const replay = await commit(host, token);
    expect(replay.status).toBe(403);
    const envelope = await envelopeOf(replay);
    expect(envelope.ok).toBe(false);
    expect(!envelope.ok && envelope.error.message).toContain("already_used");
    expect(purged).toEqual(["Old"]);
  });

  it("replays within the TTL when no store is registered", async () => {
    const host = createHost();
    const { token, approvalId } = await prepare(host);

    // Documented stateless-HMAC behaviour, unchanged: the store is what fixes it.
    expect(approvalId).toBeUndefined();
    expect((await commit(host, token)).status).toBe(200);
    expect((await commit(host, token)).status).toBe(200);
    expect(purged).toEqual(["Old", "Old"]);
  });

  it("coalesces repeated prepares into one proposal", async () => {
    const store = createMemoryApprovalStore();
    setCapabilityApprovalStore(store);
    const host = createHost();

    const first = await prepare(host);
    const second = await prepare(host);

    expect(second.approvalId).toBe(first.approvalId);
    expect(await store.listPending()).toHaveLength(1);
  });

  it("scopes proposals by principal and by input", async () => {
    const store = createMemoryApprovalStore();
    setCapabilityApprovalStore(store);
    const host = createHost();

    await prepare(host, { titlePrefix: "Old" });
    await prepare(host, { titlePrefix: "Older" });
    await envelopeOf(
      await host.request(
        "notes.purge",
        { titlePrefix: "Old" },
        { agent: { verified: true, agentDomain: "bot.example", keyId: "key-1" } },
      ),
    );

    expect(await store.listPending()).toHaveLength(3);
  });

  it("does not let a forged token burn a live proposal", async () => {
    const store = createMemoryApprovalStore();
    setCapabilityApprovalStore(store);
    const host = createHost();
    const { token, approvalId } = await prepare(host);

    const forged = await commit(host, "v1.bogus.signature");
    expect(forged.status).toBe(403);
    expect(await store.get(approvalId!)).toMatchObject({ state: "pending" });

    expect((await commit(host, token)).status).toBe(200);
  });

  it("fails closed when the token is valid but the proposal is unknown", async () => {
    // Prepare on one replica, commit on another that shares no storage: the
    // stateless token still verifies, but there is no proposal to consume.
    setCapabilityApprovalStore(createMemoryApprovalStore());
    const { token } = await prepare(createHost());

    setCapabilityApprovalStore(createMemoryApprovalStore());
    const response = await commit(createHost(), token);

    expect(response.status).toBe(403);
    const envelope = await envelopeOf(response);
    expect(!envelope.ok && envelope.error.message).toContain("unknown");
    expect(purged).toEqual([]);
  });

  it("keeps the token bound to the exact input", async () => {
    setCapabilityApprovalStore(createMemoryApprovalStore());
    const host = createHost();
    const { token } = await prepare(host);

    const tampered = await commit(host, token, { titlePrefix: "Everything" });
    expect(tampered.status).toBe(403);
    const envelope = await envelopeOf(tampered);
    expect(!envelope.ok && envelope.error.message).toContain("input_mismatch");
    expect(purged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// human mode
// ---------------------------------------------------------------------------

describe("human mode", () => {
  const agents: PrachtAgentsConfig = { confirmation: { mode: "human" } };

  it("parks the commit until a person approves, then runs exactly once", async () => {
    const store = createMemoryApprovalStore();
    setCapabilityApprovalStore(store);
    const host = createHost(agents);

    const { token, approvalId } = await prepare(host);
    const early = await commit(host, token);
    expect(early.status).toBe(409);
    const pendingEnvelope = await envelopeOf(early);
    expect(!pendingEnvelope.ok && pendingEnvelope.error.code).toBe("confirmation_pending");
    expect(!pendingEnvelope.ok && pendingEnvelope.error.approvalId).toBe(approvalId);
    expect(purged).toEqual([]);

    const [proposal] = await store.listPending();
    expect(proposal.input).toEqual({ titlePrefix: "Old" });
    expect(await store.decide(proposal.id, "approved", "reviewer@example")).toBe(true);

    expect((await commit(host, token)).status).toBe(200);
    expect(purged).toEqual(["Old"]);

    expect((await commit(host, token)).status).toBe(403);
    expect(purged).toEqual(["Old"]);
  });

  it("says approval is needed on prepare", async () => {
    setCapabilityApprovalStore(createMemoryApprovalStore());
    const host = createHost(agents);

    const envelope = await envelopeOf(await host.request("notes.purge", { titlePrefix: "Old" }));
    expect(!envelope.ok && envelope.error.code).toBe("confirmation_required");
    expect(!envelope.ok && envelope.error.message).toContain("human approval");
  });

  it("honours a rejection", async () => {
    const store = createMemoryApprovalStore();
    setCapabilityApprovalStore(store);
    const host = createHost(agents);
    const { token, approvalId } = await prepare(host);

    await store.decide(approvalId!, "rejected", "reviewer@example");

    const response = await commit(host, token);
    expect(response.status).toBe(403);
    const envelope = await envelopeOf(response);
    expect(!envelope.ok && envelope.error.message).toContain("rejected");
    expect(purged).toEqual([]);
  });

  it("fails closed without a store instead of self-approving", async () => {
    const host = createHost(agents);

    const envelope = await envelopeOf(await host.request("notes.purge", { titlePrefix: "Old" }));
    expect(!envelope.ok && envelope.error.code).toBe("confirmation_unavailable");
    expect(!envelope.ok && envelope.error.message).toContain("setCapabilityApprovalStore");
    expect(purged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("a failing store never opens the gate", () => {
  function createBrokenStore(failOn: "create" | "consume"): CapabilityApprovalStore {
    const inner = createMemoryApprovalStore();
    return {
      ...inner,
      async create(record) {
        if (failOn === "create") throw new Error("database unreachable");
        return inner.create(record);
      },
      async consume(id, options): Promise<CapabilityApprovalConsumeResult> {
        if (failOn === "consume") throw new Error("database unreachable");
        return inner.consume(id, options);
      },
    };
  }

  it("fails closed when the proposal cannot be recorded", async () => {
    setCapabilityApprovalStore(createBrokenStore("create"));
    const envelope = await envelopeOf(
      await createHost().request("notes.purge", { titlePrefix: "Old" }),
    );

    expect(!envelope.ok && envelope.error.code).toBe("confirmation_unavailable");
    expect(!envelope.ok && envelope.error.message).toContain("database unreachable");
    expect(!envelope.ok && envelope.error.confirmationToken).toBeUndefined();
  });

  it("fails closed when the proposal cannot be consumed", async () => {
    setCapabilityApprovalStore(createMemoryApprovalStore());
    const host = createHost();
    const { token } = await prepare(host);

    setCapabilityApprovalStore(createBrokenStore("consume"));
    const response = await commit(host, token);

    expect(response.status).toBe(403);
    const envelope = await envelopeOf(response);
    expect(!envelope.ok && envelope.error.code).toBe("confirmation_unavailable");
    expect(purged).toEqual([]);
  });
});
