import { afterEach, describe, expect, it } from "vitest";

import {
  clearAgentDirectoryCache,
  ed25519JwkThumbprint,
  parseDirectoryJwks,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
  verifyAgentSignature,
} from "../src/runtime-agent-auth.ts";

// Fixed Ed25519 test keypair (also used by examples/basic and the e2e suite).
// The private part exists only in tests; the public `x` is safe to commit.
const TEST_PUBLIC_X = "s5n91rPm5ymJjl--scT4WWq7HE9kUdj-6sVe5r__xgc";
const TEST_PRIVATE_D = "JZlLQqnxH-0O_1mfnuqDBB1U5XgqETE5eiRXxXRhZNM";
const TEST_KEY_THUMBPRINT = "9zaO23t4-sitQq-zx7KAn4Q1Ds_W1PF07ozJfoP3H70";

const NOW = 1_800_000_000;

interface SignOptions {
  url?: string;
  method?: string;
  components?: string[];
  signatureAgent?: string | null;
  created?: number;
  expires?: number;
  keyid?: string;
  alg?: string | null;
  tag?: string;
  /** Corrupt the signature bytes after signing. */
  tamper?: boolean;
  privateD?: string;
  publicX?: string;
}

/**
 * Independent RFC 9421 signer used to produce test requests — mirrors what a
 * Web Bot Auth agent sends (draft-meunier-web-bot-auth-architecture-02).
 */
async function signedRequest(options: SignOptions = {}): Promise<Request> {
  const url = options.url ?? "https://app.example/api/capabilities/agent/whoami";
  const method = options.method ?? "POST";
  const signatureAgent =
    options.signatureAgent === undefined ? '"https://agent.example"' : options.signatureAgent;
  const components =
    options.components ?? (signatureAgent ? ["@authority", "signature-agent"] : ["@authority"]);
  const created = options.created ?? NOW - 10;
  const expires = options.expires ?? NOW + 300;
  const keyid = options.keyid ?? TEST_KEY_THUMBPRINT;

  const headers = new Headers({ "content-type": "application/json" });
  if (signatureAgent) headers.set("signature-agent", signatureAgent);

  const componentList = components.map((component) => `"${component}"`).join(" ");
  const algPart = options.alg === null ? "" : `;alg="${options.alg ?? "ed25519"}"`;
  const params =
    `(${componentList});created=${created};expires=${expires}` +
    `;keyid="${keyid}"${algPart};tag="${options.tag ?? "web-bot-auth"}"`;

  const parsedUrl = new URL(url);
  const lines = components.map((component) => {
    if (component === "@authority") return `"@authority": ${parsedUrl.host}`;
    if (component === "@method") return `"@method": ${method}`;
    if (component === "@path") return `"@path": ${parsedUrl.pathname}`;
    return `"${component}": ${headers.get(component)}`;
  });
  lines.push(`"@signature-params": ${params}`);
  const base = lines.join("\n");

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      d: options.privateD ?? TEST_PRIVATE_D,
      x: options.publicX ?? TEST_PUBLIC_X,
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(base)),
  );
  if (options.tamper) signature[0] ^= 0xff;

  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  headers.set("signature-input", `sig1=${params}`);
  headers.set("signature", `sig1=:${btoa(binary)}:`);

  return new Request(url, { method, headers, body: "{}" });
}

const staticOptions = {
  keys: [{ x: TEST_PUBLIC_X, agent: "pinned-agent.example" }],
  now: () => NOW,
};

afterEach(() => {
  clearAgentDirectoryCache();
});

describe("structured field parsing", () => {
  it("parses Signature-Input dictionaries with components and params", () => {
    const members = parseSignatureInput(
      'sig1=("@authority" "signature-agent");created=1;expires=2;keyid="abc";tag="web-bot-auth"',
    );
    expect(members).toHaveLength(1);
    expect(members![0].label).toBe("sig1");
    expect(members![0].components).toEqual(["@authority", "signature-agent"]);
    expect(members![0].params).toEqual({
      created: 1,
      expires: 2,
      keyid: "abc",
      tag: "web-bot-auth",
    });
  });

  it("returns null for malformed Signature-Input headers", () => {
    expect(parseSignatureInput("sig1=nope")).toBeNull();
    expect(parseSignatureInput('sig1=("@authority";created=x')).toBeNull();
    expect(parseSignatureInput("sig1=(@authority);created=1")).toBeNull();
  });

  it("parses Signature byte-sequence dictionaries and rejects malformed ones", () => {
    const parsed = parseSignatureHeader("sig1=:aGVsbG8=:");
    expect(parsed).not.toBeNull();
    expect(new TextDecoder().decode(parsed!.sig1)).toBe("hello");
    expect(parseSignatureHeader("sig1=aGVsbG8=")).toBeNull();
    expect(parseSignatureHeader("sig1=:!!!:")).toBeNull();
  });

  it("parses Signature-Agent as an https-only sf-string", () => {
    expect(parseSignatureAgent('"https://agent.example"')?.host).toBe("agent.example");
    expect(parseSignatureAgent("https://agent.example")?.host).toBe("agent.example");
    expect(parseSignatureAgent('"http://agent.example"')).toBeNull();
    expect(parseSignatureAgent('"https://user:pw@agent.example"')).toBeNull();
    expect(parseSignatureAgent('"not a url"')).toBeNull();
  });
});

describe("verifyAgentSignature", () => {
  it("verifies a signed request against a static key (round-trip)", async () => {
    const request = await signedRequest();
    const identity = await verifyAgentSignature(request, staticOptions);
    expect(identity).toEqual({
      verified: true,
      agentDomain: "pinned-agent.example",
      keyId: TEST_KEY_THUMBPRINT,
    });
  });

  it("does not let Signature-Agent override a static key's pinned label", async () => {
    const request = await signedRequest({ signatureAgent: '"https://trusted.example"' });
    const identity = await verifyAgentSignature(request, staticOptions);
    expect(identity?.agentDomain).toBe("pinned-agent.example");
  });

  it("uses the static key's agent label when no Signature-Agent header is sent", async () => {
    const request = await signedRequest({ signatureAgent: null });
    const identity = await verifyAgentSignature(request, staticOptions);
    expect(identity?.agentDomain).toBe("pinned-agent.example");
  });

  it("returns null for unsigned requests", async () => {
    const request = new Request("https://app.example/", { method: "POST" });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("fails closed on a tampered signature", async () => {
    const request = await signedRequest({ tamper: true });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("fails closed when signed by a different key", async () => {
    // A fresh keypair signs, but the keyid still points at the trusted key.
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as {
      d: string;
      x: string;
    };
    const request = await signedRequest({ privateD: jwk.d, publicX: jwk.x });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("fails closed on an expired signature", async () => {
    const request = await signedRequest({ created: NOW - 700, expires: NOW - 400 });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("allows small clock skew on expiry", async () => {
    const request = await signedRequest({ created: NOW - 400, expires: NOW - 30 });
    expect(await verifyAgentSignature(request, staticOptions)).not.toBeNull();
  });

  it("fails closed on a not-yet-valid signature", async () => {
    const request = await signedRequest({ created: NOW + 600, expires: NOW + 900 });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("fails closed when @authority is not covered", async () => {
    const request = await signedRequest({ components: ["@method", "signature-agent"] });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("fails closed when signature-agent is sent but not covered", async () => {
    const request = await signedRequest({ components: ["@authority"] });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("ignores signatures without the web-bot-auth tag", async () => {
    const request = await signedRequest({ tag: "other-tag" });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });

  it("fails closed when the authority differs (signature bound to another host)", async () => {
    const request = await signedRequest();
    const replayed = new Request("https://other.example/api/capabilities/agent/whoami", {
      method: "POST",
      headers: request.headers,
      body: "{}",
    });
    expect(await verifyAgentSignature(replayed, staticOptions)).toBeNull();
  });

  it("rejects non-ed25519 alg parameters", async () => {
    const request = await signedRequest({ alg: "rsa-pss-sha512" });
    expect(await verifyAgentSignature(request, staticOptions)).toBeNull();
  });
});

describe("key directory resolution", () => {
  function directoryFetch(jwks: unknown): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/http-message-signatures-directory+json" },
      });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  const directoryJwks = { keys: [{ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_X }] };

  it("resolves keys from an allowlisted directory and caches by TTL", async () => {
    const { fetchImpl, calls } = directoryFetch(directoryJwks);
    const options = {
      directories: ["https://agent.example"],
      now: () => NOW,
      fetchImpl,
    };

    const first = await verifyAgentSignature(await signedRequest(), options);
    expect(first?.agentDomain).toBe("agent.example");
    expect(calls).toEqual(["https://agent.example/.well-known/http-message-signatures-directory"]);

    // Second verification within the TTL reuses the cached directory.
    const second = await verifyAgentSignature(await signedRequest(), options);
    expect(second?.verified).toBe(true);
    expect(calls).toHaveLength(1);

    // After the cache is cleared the directory is fetched again.
    clearAgentDirectoryCache();
    await verifyAgentSignature(await signedRequest(), options);
    expect(calls).toHaveLength(2);
  });

  it("never fetches directories that are not allowlisted", async () => {
    const { fetchImpl, calls } = directoryFetch(directoryJwks);
    const identity = await verifyAgentSignature(await signedRequest(), {
      directories: ["https://other-agent.example"],
      now: () => NOW,
      fetchImpl,
    });
    expect(identity).toBeNull();
    expect(calls).toEqual([]);
  });

  it("fails closed when the directory fetch errors", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const identity = await verifyAgentSignature(await signedRequest(), {
      directories: ["https://agent.example"],
      now: () => NOW,
      fetchImpl,
    });
    expect(identity).toBeNull();
  });

  it("parses JWKS entries, dropping non-Ed25519 and kid-mismatched keys", async () => {
    const keys = await parseDirectoryJwks({
      keys: [
        { kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_X },
        { kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_X, kid: "wrong-kid" },
        { kty: "RSA", n: "...", e: "AQAB" },
        { kty: "OKP", crv: "X25519", x: "abc" },
        "garbage",
      ],
    });
    expect(keys).toEqual([{ keyId: TEST_KEY_THUMBPRINT, x: TEST_PUBLIC_X, agent: null }]);
    expect(await parseDirectoryJwks(null)).toEqual([]);
    expect(await parseDirectoryJwks({ keys: "nope" })).toEqual([]);
  });

  it("computes the RFC 8037 JWK thumbprint used as keyid", async () => {
    expect(await ed25519JwkThumbprint(TEST_PUBLIC_X)).toBe(TEST_KEY_THUMBPRINT);
  });
});
