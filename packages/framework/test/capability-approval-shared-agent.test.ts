import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import {
  createCapabilityHost,
  createMemoryApprovalStore,
  setCapabilityApprovalPrincipalResolver,
  setCapabilityApprovalStore,
  setCapabilityConfirmationSecret,
} from "../../capabilities/src/server/index.ts";
import type { CapabilityApprovalStore } from "../../capabilities/src/server/index.ts";
import { createAgentSignatureHeaders, type AgentSigningJwk } from "../src/agent-auth-sign.ts";

// Many users share one agent platform, and so one Web Bot Auth key. A human
// decision for one of them must never authorize another's identical call.

const ORIGIN = "https://app.example";
const AGENT = "https://agent-platform.example";

let ran: string[] = [];
let store: CapabilityApprovalStore;
let privateKeyJwk: AgentSigningJwk;
let publicX: string;

const cancel = defineCapability({
  title: "Cancel subscription",
  description: "Cancel the caller's subscription.",
  effect: "destructive",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: { cancelled: { type: "string" } },
    required: ["cancelled"],
  },
  expose: { http: true, mcp: true },
  async run({ context }) {
    const user = (context as { user: string }).user;
    ran.push(user);
    return { cancelled: user };
  },
});

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; approvalId?: string; confirmationToken?: string; message: string };
}

beforeEach(async () => {
  ran = [];
  store = createMemoryApprovalStore();
  setCapabilityApprovalStore(store);
  setCapabilityConfirmationSecret("s".repeat(48));
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  privateKeyJwk = { kty: "OKP", crv: "Ed25519", d: jwk.d!, x: jwk.x! };
  publicX = jwk.x!;
});

afterEach(() => {
  setCapabilityApprovalStore(null);
  setCapabilityConfirmationSecret(null);
  setCapabilityApprovalPrincipalResolver(null);
  vi.restoreAllMocks();
});

function httpHost() {
  return createCapabilityHost({
    capabilities: { "subscription.cancel": cancel },
    agents: {
      webBotAuth: { keys: [{ x: publicX, agent: AGENT }] },
      confirmation: { mode: "human" },
    },
    createContext: (request) => ({ user: request.headers.get("x-user") }),
  });
}

async function signedCall(
  host: ReturnType<typeof httpHost>,
  user: string,
  token?: string,
): Promise<{ status: number; body: Envelope }> {
  const request = new Request(`${ORIGIN}/api/capabilities/subscription/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user": user,
      ...(token ? { "x-pracht-confirm": token } : {}),
    },
    body: "{}",
  });
  const signature = await createAgentSignatureHeaders(request, { agent: AGENT, privateKeyJwk });
  for (const [name, value] of Object.entries(signature)) request.headers.set(name, value);
  const response = await host.fetch(request);
  return { status: response!.status, body: (await response!.json()) as Envelope };
}

describe("human approval behind a shared agent key", () => {
  it("never lets one user's commit spend another user's approval", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = httpHost();

    const alicePrepare = await signedCall(host, "alice");
    expect(alicePrepare.status).toBe(409);
    await store.decide(alicePrepare.body.error!.approvalId!, "approved", "alice");

    const bobPrepare = await signedCall(host, "bob");
    expect(bobPrepare.status).toBe(409);
    expect(bobPrepare.body.error!.approvalId).not.toBe(alicePrepare.body.error!.approvalId);

    const bobCommit = await signedCall(host, "bob", bobPrepare.body.error!.confirmationToken);
    expect(bobCommit.status).toBe(409);
    expect(bobCommit.body.error!.code).toBe("confirmation_pending");

    const aliceCommit = await signedCall(host, "alice", alicePrepare.body.error!.confirmationToken);
    expect(aliceCommit.status).toBe(200);
    expect(ran).toEqual(["alice"]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("setCapabilityApprovalPrincipalResolver"),
    );
  });

  it("binds the application principal when one resolves", async () => {
    setCapabilityApprovalPrincipalResolver<{ user: string }>(({ context }) => context.user);
    const host = httpHost();

    const first = await signedCall(host, "alice");
    const again = await signedCall(host, "alice");
    const bob = await signedCall(host, "bob");

    // One proposal per end user and operation, as before.
    expect(again.body.error!.approvalId).toBe(first.body.error!.approvalId);
    expect(bob.body.error!.approvalId).not.toBe(first.body.error!.approvalId);
    expect((await store.get(first.body.error!.approvalId!))?.principal).toContain("app:alice");
  });

  it("binds the verified OAuth subject on remote MCP", async () => {
    const host = createCapabilityHost({
      capabilities: { "subscription.cancel": cancel },
      agents: {
        confirmation: { mode: "human" },
        mcp: {
          destructive: true,
          auth: {
            resource: `${ORIGIN}/mcp`,
            authorizationServers: ["https://auth.example"],
            verify: async (token) => ({ subject: token }),
          },
        },
      },
      createContext: (request) => ({ user: request.headers.get("authorization")!.slice(7) }),
    });

    const call = async (subject: string, token?: string) => {
      const response = await host.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${subject}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "subscription_cancel",
              arguments: {},
              ...(token ? { _meta: { "io.pracht/confirmation": token } } : {}),
            },
          }),
        }),
      );
      const body = (await response!.json()) as {
        result: {
          isError?: boolean;
          structuredContent?: unknown;
          _meta?: { "io.pracht/error"?: Envelope["error"] };
        };
      };
      return body.result.isError
        ? { ok: false, error: body.result._meta?.["io.pracht/error"] }
        : { ok: true, data: body.result.structuredContent };
    };

    const alice = await call("alice");
    const bob = await call("bob");
    expect(alice.error!.code).toBe("confirmation_required");
    expect(bob.error!.approvalId).not.toBe(alice.error!.approvalId);
    expect((await store.get(alice.error!.approvalId!))?.principal).toContain("oauth:alice");

    await store.decide(alice.error!.approvalId!, "approved", "alice");
    expect((await call("bob", bob.error!.confirmationToken)).error!.code).toBe(
      "confirmation_pending",
    );
    expect((await call("bob", alice.error!.confirmationToken)).error!.code).toBe(
      "confirmation_invalid",
    );
    expect((await call("alice", alice.error!.confirmationToken)).ok).toBe(true);
    expect(ran).toEqual(["alice"]);
  });
});
