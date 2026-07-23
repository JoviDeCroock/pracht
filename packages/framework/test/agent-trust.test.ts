import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import {
  defineApp,
  handlePrachtRequest,
  resolveApp,
  route,
  setCapabilityAuditHook,
} from "../src/index.ts";
import {
  canonicalJson,
  clearConsumedConfirmationTokens,
  consumeConfirmationToken,
  createConfirmationToken,
  setCapabilityConfirmationSecret,
  verifyConfirmationToken,
} from "../src/runtime-confirmation.ts";
import type { CapabilityAuditEvent, ModuleRegistry, PrachtAgentsConfig } from "../src/types.ts";

type CapabilityDefinition = Parameters<typeof defineCapability>[0];

const SECRET = "unit-test-confirmation-secret";

function createPurgeCapability(overrides: Record<string, unknown> = {}) {
  return defineCapability({
    title: "Purge notes",
    description: "Delete notes.",
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
    async run() {
      return { purged: 1 };
    },
    ...overrides,
  } as CapabilityDefinition);
}

function createApp(
  capabilityModule: unknown,
  agents: PrachtAgentsConfig | undefined = { confirmation: { ttlSeconds: 120 } },
) {
  const app = defineApp({
    capabilities: { "notes.purge": "./capabilities/notes-purge.ts" },
    agents,
    routes: [route("/", "./routes/home.tsx")],
  });

  const registry: ModuleRegistry = {
    routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
    capabilityModules: {
      "./capabilities/notes-purge.ts": (async () => ({
        default: capabilityModule,
      })) as NonNullable<ModuleRegistry["capabilityModules"]>[string],
    },
  };

  return { app, registry };
}

function postPurge(input: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/capabilities/notes/purge", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  setCapabilityConfirmationSecret(SECRET);
});

afterEach(() => {
  setCapabilityConfirmationSecret(null);
  clearConsumedConfirmationTokens();
  setCapabilityAuditHook(null);
});

// ---------------------------------------------------------------------------
// Confirmation token primitives
// ---------------------------------------------------------------------------

describe("confirmation tokens", () => {
  const binding = {
    secret: SECRET,
    principal: "anonymous",
    capability: "notes.purge",
    canonicalInput: canonicalJson({ titlePrefix: "x" }),
  };

  it("round-trips: created tokens verify against the same binding", async () => {
    const { token, expiresAt } = await createConfirmationToken({ ...binding, ttlSeconds: 120 });
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const result = await verifyConfirmationToken(token, binding);
    expect(result.ok).toBe(true);
  });

  it("rejects expired tokens", async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const { token } = await createConfirmationToken({ ...binding, ttlSeconds: 120, now: past });
    const result = await verifyConfirmationToken(token, binding);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampered tokens", async () => {
    const { token } = await createConfirmationToken({ ...binding, ttlSeconds: 120 });
    const [version, , signature] = token.split(".");
    // Forge different claims but keep the original signature.
    const forgedPayload = btoa(
      JSON.stringify({ p: "anonymous", c: "other.capability", i: "x", exp: 9999999999 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${version}.${forgedPayload}.${signature}`;
    const result = await verifyConfirmationToken(forged, binding);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyConfirmationToken("v1.garbage", binding)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects principal, capability, and input mismatches", async () => {
    const { token } = await createConfirmationToken({ ...binding, ttlSeconds: 120 });
    expect(await verifyConfirmationToken(token, { ...binding, principal: "agent:abc" })).toEqual({
      ok: false,
      reason: "principal_mismatch",
    });
    expect(
      await verifyConfirmationToken(token, { ...binding, capability: "notes.create" }),
    ).toEqual({ ok: false, reason: "capability_mismatch" });
    expect(
      await verifyConfirmationToken(token, {
        ...binding,
        canonicalInput: canonicalJson({ titlePrefix: "y" }),
      }),
    ).toEqual({ ok: false, reason: "input_mismatch" });
  });

  it("canonicalizes JSON independently of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("enforces single-use per instance", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    expect(consumeConfirmationToken("sig-a", expiresAt)).toBe(true);
    expect(consumeConfirmationToken("sig-a", expiresAt)).toBe(false);
    expect(consumeConfirmationToken("sig-b", expiresAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP prepare/commit flow
// ---------------------------------------------------------------------------

describe("destructive capability HTTP flow", () => {
  it("answers confirmation_required with a token instead of running", async () => {
    const { app, registry } = createApp(createPurgeCapability());
    const response = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("confirmation_required");
    expect(typeof body.error.confirmationToken).toBe("string");
    expect(typeof body.error.expiresAt).toBe("number");
  });

  it("runs on commit with the token and byte-identical canonical input", async () => {
    const { app, registry } = createApp(createPurgeCapability());
    const prepare = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    const token = (await prepare.json()).error.confirmationToken as string;

    const commit = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }, { "x-pracht-confirm": token }),
    });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toEqual({ ok: true, data: { purged: 1 } });
  });

  it("rejects commits whose input differs from the prepared input", async () => {
    const { app, registry } = createApp(createPurgeCapability());
    const prepare = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    const token = (await prepare.json()).error.confirmationToken as string;

    const commit = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "everything" }, { "x-pracht-confirm": token }),
    });
    expect(commit.status).toBe(403);
    const body = await commit.json();
    expect(body.error.code).toBe("confirmation_invalid");
    expect(body.error.message).toContain("input_mismatch");
  });

  it("rejects tampered tokens with 403", async () => {
    const { app, registry } = createApp(createPurgeCapability());
    const commit = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }, { "x-pracht-confirm": "v1.fake.fake" }),
    });
    expect(commit.status).toBe(403);
    expect((await commit.json()).error.code).toBe("confirmation_invalid");
  });

  it("fails closed when no confirmation secret is configured", async () => {
    setCapabilityConfirmationSecret(null);
    const { app, registry } = createApp(createPurgeCapability());
    const response = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("confirmation_unavailable");
    expect(body.error.confirmationToken).toBeUndefined();
  });

  it("still validates input first (400 before any token logic)", async () => {
    const { app, registry } = createApp(createPurgeCapability());
    const response = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({}),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_input");
  });

  it("runs capability middleware during a prepare, not just the commit", async () => {
    let middlewareCalls = 0;
    const app = defineApp({
      capabilities: { "notes.purge": "./capabilities/notes-purge.ts" },
      middleware: { count: "./middleware/count.ts" },
      agents: { confirmation: { ttlSeconds: 120 } },
      routes: [route("/", "./routes/home.tsx")],
    });
    const registry: ModuleRegistry = {
      routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
      capabilityModules: {
        "./capabilities/notes-purge.ts": (async () => ({
          default: createPurgeCapability({ middleware: ["count"] }),
        })) as NonNullable<ModuleRegistry["capabilityModules"]>[string],
      },
      middlewareModules: {
        "./middleware/count.ts": (async () => ({
          middleware: async (_args: unknown, next: () => Promise<Response>) => {
            middlewareCalls += 1;
            return next();
          },
        })) as NonNullable<ModuleRegistry["middlewareModules"]>[string],
      },
    };

    const prepare = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    expect(prepare.status).toBe(409);
    // The confirmation gate now runs inside the middleware chain, so
    // rate-limiting middleware sees the prepare attempt too.
    expect(middlewareCalls).toBe(1);
  });

  it("optionally consumes tokens once per instance (singleUse)", async () => {
    const { app, registry } = createApp(createPurgeCapability(), {
      confirmation: { ttlSeconds: 120, singleUse: true },
    });
    const prepare = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    const token = (await prepare.json()).error.confirmationToken as string;

    const first = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }, { "x-pracht-confirm": token }),
    });
    expect(first.status).toBe(200);

    const replay = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }, { "x-pracht-confirm": token }),
    });
    expect(replay.status).toBe(403);
    expect((await replay.json()).error.message).toContain("already_used");
  });
});

// ---------------------------------------------------------------------------
// Web Bot Auth policy + context.agent + audit trail
// ---------------------------------------------------------------------------

describe("agent policy and audit", () => {
  it('"require" policy rejects unsigned requests with the 401 envelope', async () => {
    const { app, registry } = createApp(
      createPurgeCapability({ effect: "read", agentPolicy: "require" }),
      { webBotAuth: { policy: "observe" } },
    );
    const response = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("agent_required");
  });

  it('"observe" mode serves unsigned requests and sets context.agent to null', async () => {
    const capability = createPurgeCapability({
      effect: "read",
      output: {
        type: "object",
        properties: { agentChecked: { type: "boolean" } },
        required: ["agentChecked"],
      },
      async run({ context }: { context: { agent?: unknown } }) {
        return { agentChecked: "agent" in context && context.agent === null };
      },
    });
    const { app, registry } = createApp(capability, { webBotAuth: { policy: "observe" } });
    const response = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
    });
    expect(await response.json()).toEqual({ ok: true, data: { agentChecked: true } });
  });

  it("emits audit events with capability, effect, outcome, and duration", async () => {
    const events: CapabilityAuditEvent[] = [];
    setCapabilityAuditHook((event) => events.push(event));

    const { app, registry } = createApp(createPurgeCapability());
    await handlePrachtRequest({ app, registry, request: postPurge({ titlePrefix: "x" }) });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      capability: "notes.purge",
      effect: "destructive",
      transport: "http",
      outcome: "confirmation_required",
      status: 409,
      agent: null,
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("also invokes the onCapabilityAudit runtime option and survives hook errors", async () => {
    setCapabilityAuditHook(() => {
      throw new Error("hook exploded");
    });
    const events: CapabilityAuditEvent[] = [];

    const { app, registry } = createApp(createPurgeCapability({ effect: "read" }));
    const response = await handlePrachtRequest({
      app,
      registry,
      request: postPurge({ titlePrefix: "x" }),
      onCapabilityAudit: (event) => events.push(event),
    });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("ok");
  });
});

describe("agents config validation", () => {
  function buildApp(agents: PrachtAgentsConfig) {
    return defineApp({
      agents,
      routes: [route("/", "./routes/home.tsx")],
    });
  }

  it("rejects an unknown webBotAuth policy (fails closed, not open)", () => {
    const app = buildApp({ webBotAuth: { policy: "requre" as never } });
    expect(() => resolveApp(app)).toThrow(/policy/);
  });

  it("accepts the valid policies", () => {
    expect(() => resolveApp(buildApp({ webBotAuth: { policy: "require" } }))).not.toThrow();
    expect(() => resolveApp(buildApp({ webBotAuth: { policy: "observe" } }))).not.toThrow();
  });

  it("rejects non-positive numeric trust settings", () => {
    expect(() => resolveApp(buildApp({ confirmation: { ttlSeconds: 0 } }))).toThrow(
      /positive number/,
    );
    expect(() => resolveApp(buildApp({ webBotAuth: { clockSkewSeconds: -1 } }))).toThrow(
      /positive number/,
    );
  });
});
