import type { AgentSignatureHeaders, AgentSignatureOptions } from "./agent-auth-sign-types.ts";
import { ed25519JwkThumbprint } from "./runtime-agent-directory.ts";

const REQUIRED_COMPONENTS = ["@authority", "signature-agent"] as const;
const DEFAULT_LIFETIME_SECONDS = 300;
const MAX_LIFETIME_SECONDS = 86_400;
const WEB_BOT_AUTH_TAG = "web-bot-auth";
const HEADER_CRLF_RE = /[\r\n]/;
const SIGNATURE_LABEL_RE = /^[a-z*][a-z0-9_\-.*]*$/;
const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build the RFC 9421 signature base exactly as the verifier expects it. */
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

export async function createAgentSignatureHeaders(
  request: Request,
  options: AgentSignatureOptions,
): Promise<AgentSignatureHeaders> {
  const { agent, privateKeyJwk } = options;
  if (!agent) throw new Error("[pracht] signAgentRequest requires an `agent` identity.");
  if (HEADER_CRLF_RE.test(agent)) {
    throw new Error("[pracht] signAgentRequest `agent` must not contain CR or LF.");
  }
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
  if (!SIGNATURE_LABEL_RE.test(label)) {
    throw new Error(
      `[pracht] signAgentRequest label ${JSON.stringify(label)} is not a valid ` +
        "RFC 8941 dictionary key.",
    );
  }
  const keyId = options.keyId ?? (await ed25519JwkThumbprint(privateKeyJwk.x));
  if (/["\\]/.test(keyId)) {
    throw new Error(
      `[pracht] signAgentRequest keyId ${JSON.stringify(keyId)} must not contain quotes or backslashes.`,
    );
  }
  const signatureAgent = quoteString(agent);
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

/** Return an independently usable copy of a request carrying signature headers. */
export async function signAgentRequest(
  request: Request,
  options: AgentSignatureOptions,
): Promise<Request> {
  const headers = await createAgentSignatureHeaders(request, options);
  const signed = new Request(request.bodyUsed ? request : request.clone());
  for (const [name, value] of Object.entries(headers)) signed.headers.set(name, value);
  return signed;
}
