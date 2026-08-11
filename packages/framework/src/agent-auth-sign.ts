/**
 * Web Bot Auth: the *signing* side of RFC 9421 HTTP Message Signatures.
 *
 * `runtime-agent-auth.ts` verifies inbound agent requests. This module is its
 * counterpart for outbound ones — what an agent, an eval scenario, or a test
 * needs to actually reach a capability that declares `agentPolicy: "require"`.
 *
 * It lives behind its own entry point (`@pracht/core/agent-auth`) rather than
 * on `@pracht/core/server` because nothing in a deployed app signs requests;
 * bundling a private-key code path into every worker would be pure weight.
 *
 * Web-platform only (`crypto.subtle`, `Headers`), so it runs anywhere the
 * verifier does: Node ≥ 20, Workers, and Vercel Edge.
 *
 * ```ts
 * import { signAgentRequest } from "@pracht/core/agent-auth";
 *
 * const response = await fetch(
 *   await signAgentRequest(new Request(url, { method: "POST", body }), {
 *     agent: "https://my-agent.example",
 *     privateKeyJwk: { crv: "Ed25519", d: "...", kty: "OKP", x: "..." },
 *   }),
 * );
 * ```
 */

import { ed25519JwkThumbprint } from "./runtime-agent-auth.ts";

/** Ed25519 private key in JWK form — the `d` (private) and `x` (public) pair. */
export interface AgentSigningJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** Base64url private scalar. */
  d: string;
  /** Base64url public key. */
  x: string;
}

export interface AgentSignatureOptions {
  /**
   * The agent's `Signature-Agent` identity — the HTTPS origin serving its key
   * directory, e.g. `https://my-agent.example`. Sent as a quoted string and
   * covered by the signature.
   */
  agent: string;
  /** The agent's Ed25519 private key. */
  privateKeyJwk: AgentSigningJwk;
  /**
   * `keyid`. Defaults to the RFC 8037 JWK thumbprint of `privateKeyJwk.x`,
   * which is what the verifier and the key directory both expect — override
   * only to reproduce a non-conforming peer.
   */
  keyId?: string;
  /** Signature validity window in seconds. Default 300; the draft caps it at 24 h. */
  lifetimeSeconds?: number;
  /** `created` as a Unix timestamp in seconds. Defaults to now. */
  createdAt?: number;
  /** Signature label. Default `sig1`. */
  label?: string;
  /**
   * Extra covered components beyond `@authority` and `signature-agent`, e.g.
   * `["@method", "@path"]`. Header names must be lowercase.
   */
  additionalComponents?: readonly string[];
  /** Optional `nonce` parameter. Pracht's verifier does not enforce uniqueness. */
  nonce?: string;
}

/** The three headers a signed Web Bot Auth request carries. */
export interface AgentSignatureHeaders {
  "signature-agent": string;
  "signature-input": string;
  signature: string;
}

const REQUIRED_COMPONENTS = ["@authority", "signature-agent"] as const;
const DEFAULT_LIFETIME_SECONDS = 300;
const MAX_LIFETIME_SECONDS = 86_400;
const WEB_BOT_AUTH_TAG = "web-bot-auth";
const HEADER_CRLF_RE = /[\r\n]/;
/** RFC 8941 key: lowercase alpha or `*` first, then alphanumerics and `_-.*`. */
const SIGNATURE_LABEL_RE = /^[a-z*][a-z0-9_\-.*]*$/;

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * RFC 8941 quoted string. Escaping matters: an agent identity containing a
 * quote would otherwise produce a `Signature-Agent` header the verifier parses
 * differently than the signer signed, which fails closed but confusingly.
 */
function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The RFC 9421 signature base. Mirrors `buildSignatureBase()` in the verifier —
 * the two must agree byte-for-byte or nothing verifies.
 */
function buildSigningBase(
  request: Request,
  components: readonly string[],
  signatureAgent: string,
  params: string,
): string {
  const url = new URL(request.url);
  const lines: string[] = [];

  for (const component of components) {
    let value: string;
    switch (component) {
      case "@authority":
        value = url.host.toLowerCase();
        break;
      case "@method":
        value = request.method.toUpperCase();
        break;
      case "@scheme":
        value = url.protocol.replace(/:$/, "");
        break;
      case "@target-uri":
        value = request.url;
        break;
      case "@path":
        value = url.pathname;
        break;
      case "@query":
        value = url.search === "" ? "?" : url.search;
        break;
      case "signature-agent":
        value = signatureAgent;
        break;
      default: {
        if (component.startsWith("@")) {
          throw new Error(
            `[pracht] Cannot sign unsupported derived component ${JSON.stringify(component)}. ` +
              'Supported: "@authority", "@method", "@scheme", "@target-uri", "@path", "@query".',
          );
        }
        if (component !== component.toLowerCase()) {
          throw new Error(
            `[pracht] Covered header component ${JSON.stringify(component)} must be lowercase.`,
          );
        }
        const headerValue = request.headers.get(component);
        if (headerValue === null) {
          throw new Error(
            `[pracht] Cannot sign header component ${JSON.stringify(component)}: the request ` +
              "does not carry it. Set the header before signing.",
          );
        }
        value = headerValue.trim().replace(/[\r\n]+\s*/g, " ");
      }
    }
    lines.push(`"${component}": ${value}`);
  }

  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

/**
 * Build the `Signature-Agent`, `Signature-Input`, and `Signature` headers for
 * `request`, without modifying it.
 *
 * The signature covers `@authority`, so it is bound to the host the request is
 * actually delivered to. Signing `localhost:3000` and having the server observe
 * `app.example.com` (a Cloudflare custom-domain route in `wrangler dev`, say)
 * will not verify — sign the authority the server sees.
 */
export async function createAgentSignatureHeaders(
  request: Request,
  options: AgentSignatureOptions,
): Promise<AgentSignatureHeaders> {
  const { agent, privateKeyJwk } = options;
  if (!agent) throw new Error("[pracht] signAgentRequest requires an `agent` identity.");
  // RFC 8941 quoted strings cannot carry CR/LF, and `quoteString` only escapes
  // quotes and backslashes. Left unchecked, an agent identity built from
  // untrusted input could smuggle a newline into the `Signature-Agent` header.
  if (HEADER_CRLF_RE.test(agent)) {
    throw new Error("[pracht] signAgentRequest `agent` must not contain CR or LF.");
  }
  // The verifier derives the agent domain from this URL, so a scheme-less value
  // produces a signature that verifies against nothing — silently, because
  // Web Bot Auth fails closed. Reject it here where the cause is obvious.
  let agentUrl: URL;
  try {
    agentUrl = new URL(agent);
  } catch {
    throw new Error(
      `[pracht] signAgentRequest \`agent\` must be an absolute URL, got ${JSON.stringify(agent)}.`,
    );
  }
  if (agentUrl.protocol !== "https:" && agentUrl.hostname !== "localhost") {
    throw new Error(
      `[pracht] signAgentRequest \`agent\` must be an https URL, got ${JSON.stringify(agent)}.`,
    );
  }
  if (privateKeyJwk?.kty !== "OKP" || privateKeyJwk.crv !== "Ed25519" || !privateKeyJwk.d) {
    throw new Error("[pracht] signAgentRequest requires an Ed25519 (OKP) private key JWK.");
  }

  const lifetime = options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS) {
    throw new Error(
      `[pracht] signAgentRequest lifetimeSeconds must be between 1 and ${MAX_LIFETIME_SECONDS}.`,
    );
  }

  const created = Math.floor(options.createdAt ?? Date.now() / 1000);
  const label = options.label ?? "sig1";
  // The label is interpolated straight into two structured-field dictionaries.
  // An unvalidated one could inject a second member (`sig1=…, evil`) whose
  // parse the signer and verifier would disagree about.
  if (!SIGNATURE_LABEL_RE.test(label)) {
    throw new Error(
      `[pracht] signAgentRequest label ${JSON.stringify(label)} is not a valid ` +
        "RFC 8941 dictionary key.",
    );
  }
  const keyId = options.keyId ?? (await ed25519JwkThumbprint(privateKeyJwk.x));
  // `keyid` is a quoted string in two places; a quote or backslash in it would
  // be escaped in one and re-parsed differently, yielding a signature the
  // verifier silently rejects.
  if (/["\\]/.test(keyId)) {
    throw new Error(
      `[pracht] signAgentRequest keyId ${JSON.stringify(keyId)} must not contain quotes or backslashes.`,
    );
  }
  const signatureAgent = quoteString(agent);

  // `@authority` and `signature-agent` are what the verifier requires; extras
  // are appended in the caller's order and deduplicated.
  const components = [
    ...REQUIRED_COMPONENTS,
    ...(options.additionalComponents ?? []).filter(
      (component) =>
        !REQUIRED_COMPONENTS.includes(component as (typeof REQUIRED_COMPONENTS)[number]),
    ),
  ];

  const params =
    `(${components.map((component) => quoteString(component)).join(" ")})` +
    `;created=${created};expires=${created + lifetime}` +
    `;keyid=${quoteString(keyId)};alg="ed25519"` +
    (options.nonce === undefined ? "" : `;nonce=${quoteString(options.nonce)}`) +
    `;tag="${WEB_BOT_AUTH_TAG}"`;

  const base = buildSigningBase(request, components, signatureAgent, params);

  const key = await crypto.subtle.importKey(
    "jwk",
    { crv: "Ed25519", d: privateKeyJwk.d, key_ops: ["sign"], kty: "OKP", x: privateKeyJwk.x },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encoder.encode(base)));

  return {
    signature: `${label}=:${bytesToBase64(signature)}:`,
    "signature-agent": signatureAgent,
    "signature-input": `${label}=${params}`,
  };
}

/**
 * Return a copy of `request` carrying Web Bot Auth signature headers.
 *
 * The original stays usable, including its body. That costs a `clone()`:
 * `new Request(otherRequest)` *disturbs* the source per the Fetch standard, so
 * the obvious one-liner would leave the caller holding a request whose body
 * throws on read — surprising for anyone who signs and then also logs the
 * payload. `clone()` throws if the body was already consumed, which is the
 * right failure: there is nothing left to sign and send.
 */
export async function signAgentRequest(
  request: Request,
  options: AgentSignatureOptions,
): Promise<Request> {
  const headers = await createAgentSignatureHeaders(request, options);
  const signed = new Request(request.bodyUsed ? request : request.clone());
  for (const [name, value] of Object.entries(headers)) signed.headers.set(name, value);
  return signed;
}

/**
 * Generate an Ed25519 keypair for an agent: the private JWK to sign with, the
 * public JWK to publish in a key directory, and the `keyid` thumbprint both
 * sides use to refer to it.
 */
export async function generateAgentKeyPair(): Promise<{
  keyId: string;
  privateKeyJwk: AgentSigningJwk;
  publicKeyJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as {
    d?: string;
    x?: string;
  };
  if (!privateJwk.d || !privateJwk.x) {
    throw new Error("[pracht] Ed25519 key generation did not produce a usable JWK.");
  }

  return {
    keyId: await ed25519JwkThumbprint(privateJwk.x),
    privateKeyJwk: { crv: "Ed25519", d: privateJwk.d, kty: "OKP", x: privateJwk.x },
    publicKeyJwk: { crv: "Ed25519", kty: "OKP", x: privateJwk.x },
  };
}
