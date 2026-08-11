import { describe, expect, it } from "vitest";

import {
  createAgentSignatureHeaders,
  generateAgentKeyPair,
  signAgentRequest,
} from "../src/agent-auth-sign.ts";
import { verifyAgentSignature } from "../src/runtime-agent-auth.ts";

// The e2e suite's test agent: a *public* key committed on purpose, paired here
// with its private half so the signer can be verified against the real verifier.
const TEST_JWK = {
  crv: "Ed25519",
  d: "JZlLQqnxH-0O_1mfnuqDBB1U5XgqETE5eiRXxXRhZNM",
  kty: "OKP",
  x: "s5n91rPm5ymJjl--scT4WWq7HE9kUdj-6sVe5r__xgc",
} as const;
const TEST_KEY_ID = "9zaO23t4-sitQq-zx7KAn4Q1Ds_W1PF07ozJfoP3H70";

const config = {
  keys: [{ agent: "test-agent.example", x: TEST_JWK.x }],
  policy: "observe" as const,
};

function request(url = "https://app.example/api/capabilities/agent/ping"): Request {
  return new Request(url, { method: "POST" });
}

describe("signAgentRequest", () => {
  // The point of the whole module: what the signer produces is exactly what the
  // verifier accepts. Anything less and the two drift silently.
  it("produces a signature the framework's own verifier accepts", async () => {
    const signed = await signAgentRequest(request(), {
      agent: "https://test-agent.example",
      privateKeyJwk: TEST_JWK,
    });

    await expect(verifyAgentSignature(signed, config)).resolves.toEqual({
      agentDomain: "test-agent.example",
      keyId: TEST_KEY_ID,
      verified: true,
    });
  });

  it("derives the RFC 8037 thumbprint as the default keyid", async () => {
    const headers = await createAgentSignatureHeaders(request(), {
      agent: "https://test-agent.example",
      privateKeyJwk: TEST_JWK,
    });

    expect(headers["signature-input"]).toContain(`keyid="${TEST_KEY_ID}"`);
    expect(headers["signature-input"]).toContain('tag="web-bot-auth"');
    expect(headers["signature-input"]).toMatch(/^sig1=\("@authority" "signature-agent"\)/);
    expect(headers["signature-agent"]).toBe('"https://test-agent.example"');
    expect(headers.signature).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
  });

  it("leaves the original request untouched", async () => {
    const original = request();
    const signed = await signAgentRequest(original, {
      agent: "https://test-agent.example",
      privateKeyJwk: TEST_JWK,
    });

    expect(original.headers.get("signature")).toBeNull();
    expect(signed.headers.get("signature")).not.toBeNull();
  });

  // `@authority` is covered, so a signature is bound to the host it was made
  // for. This is the Cloudflare custom-domain preview trap in miniature.
  it("does not verify against a different authority", async () => {
    const signed = await signAgentRequest(request("https://app.example/x"), {
      agent: "https://test-agent.example",
      privateKeyJwk: TEST_JWK,
    });
    const replayed = new Request("https://other.example/x", {
      headers: signed.headers,
      method: "POST",
    });

    await expect(verifyAgentSignature(replayed, config)).resolves.toBeNull();
  });

  it("does not verify once expired", async () => {
    const signed = await signAgentRequest(request(), {
      agent: "https://test-agent.example",
      // Created well outside the verifier's clock-skew allowance.
      createdAt: Math.floor(Date.now() / 1000) - 10_000,
      lifetimeSeconds: 60,
      privateKeyJwk: TEST_JWK,
    });

    await expect(verifyAgentSignature(signed, config)).resolves.toBeNull();
  });

  it("signs additional covered components and still verifies", async () => {
    const signed = await signAgentRequest(request("https://app.example/a/b?q=1"), {
      additionalComponents: ["@method", "@path", "@query"],
      agent: "https://test-agent.example",
      privateKeyJwk: TEST_JWK,
    });

    expect(signed.headers.get("signature-input")).toContain('"@method" "@path" "@query"');
    await expect(verifyAgentSignature(signed, config)).resolves.toMatchObject({ verified: true });
  });

  it("rejects inputs it cannot sign correctly", async () => {
    const base = { agent: "https://test-agent.example", privateKeyJwk: TEST_JWK };

    await expect(createAgentSignatureHeaders(request(), { ...base, agent: "" })).rejects.toThrow(
      /requires an `agent` identity/,
    );
    await expect(
      createAgentSignatureHeaders(request(), {
        ...base,
        privateKeyJwk: { ...TEST_JWK, d: "" },
      }),
    ).rejects.toThrow(/Ed25519 \(OKP\) private key/);
    await expect(
      createAgentSignatureHeaders(request(), { ...base, lifetimeSeconds: 0 }),
    ).rejects.toThrow(/lifetimeSeconds/);
    await expect(
      createAgentSignatureHeaders(request(), { ...base, lifetimeSeconds: 90_000 }),
    ).rejects.toThrow(/lifetimeSeconds/);
    // A covered header the request does not carry would silently produce a
    // signature nothing can verify.
    await expect(
      createAgentSignatureHeaders(request(), { ...base, additionalComponents: ["x-missing"] }),
    ).rejects.toThrow(/does not carry it/);
    await expect(
      createAgentSignatureHeaders(request(), { ...base, additionalComponents: ["X-Upper"] }),
    ).rejects.toThrow(/must be lowercase/);
    await expect(
      createAgentSignatureHeaders(request(), { ...base, additionalComponents: ["@unknown"] }),
    ).rejects.toThrow(/unsupported derived component/);
    // The label lands in two structured-field dictionaries verbatim; an
    // injected one could add a second member the verifier reads differently.
    await expect(
      createAgentSignatureHeaders(request(), { ...base, label: 'sig1";x=1, evil' }),
    ).rejects.toThrow(/not a valid/);
    // `quoteString` escapes quotes and backslashes but not CR/LF.
    await expect(
      createAgentSignatureHeaders(request(), {
        ...base,
        agent: "https://a.example\r\nX-Injected: 1",
      }),
    ).rejects.toThrow(/must not contain CR or LF/);
  });
});

describe("generateAgentKeyPair", () => {
  it("produces a keypair whose signatures verify under its own thumbprint", async () => {
    const { keyId, privateKeyJwk, publicKeyJwk } = await generateAgentKeyPair();

    const signed = await signAgentRequest(request(), {
      agent: "https://fresh-agent.example",
      privateKeyJwk,
    });

    await expect(
      verifyAgentSignature(signed, {
        keys: [{ agent: "fresh-agent.example", x: publicKeyJwk.x }],
        policy: "observe",
      }),
    ).resolves.toEqual({ agentDomain: "fresh-agent.example", keyId, verified: true });
  });
});
