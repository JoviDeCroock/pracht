/**
 * Web Bot Auth: verified agent identity over RFC 9421 HTTP Message Signatures.
 *
 * Implements the verifier side of
 * draft-meunier-web-bot-auth-architecture-02 (protocol) and
 * draft-meunier-http-message-signatures-directory-03 (key discovery):
 *
 *   Signature-Agent: "https://signature-agent.example"
 *   Signature-Input: sig=("@authority" "signature-agent");created=...;
 *                    expires=...;keyid="<jwk-thumbprint>";alg="ed25519";
 *                    nonce="...";tag="web-bot-auth"
 *   Signature:       sig=:<base64 ed25519 signature>:
 *
 * Everything is Web-platform only (Headers, fetch, crypto.subtle) so Node,
 * Cloudflare, and Vercel adapters share one implementation. The structured
 * field parsing below is a deliberate hand-rolled subset of RFC 8941 — just
 * dictionaries of inner-lists/byte-sequences with parameters, which is all
 * these three headers use — to avoid a runtime dependency.
 *
 * The verifier fails closed: any parse error, missing component, expired or
 * not-yet-valid window, unknown key, or bad signature yields `null`, never a
 * partially trusted identity.
 */

import type { PrachtAgentIdentity, WebBotAuthConfig, WebBotAuthStaticKey } from "./types.ts";

export const SIGNATURE_AGENT_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** The draft requires this tag; signatures with other tags are ignored. */
const WEB_BOT_AUTH_TAG = "web-bot-auth";

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
/** Draft recommends signature expiry "no more than 24 hours" after creation. */
const DEFAULT_MAX_LIFETIME_SECONDS = 86_400;
const DEFAULT_DIRECTORY_CACHE_TTL_SECONDS = 300;
/** Cap on directory response bodies — a JWKS is tiny; anything bigger is hostile. */
const DIRECTORY_MAX_BYTES = 65_536;
const DIRECTORY_FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Minimal RFC 8941 structured-field parsing (dictionaries only)
// ---------------------------------------------------------------------------

interface SignatureInputMember {
  label: string;
  /** Covered component identifiers, e.g. `@authority`, `signature-agent`. */
  components: string[];
  /** Signature parameters: created/expires are numbers, the rest strings. */
  params: Record<string, string | number>;
  /**
   * The member's raw serialization (`("@authority" ...);created=...`) —
   * RFC 9421 requires the `@signature-params` base line to reproduce it
   * byte-for-byte.
   */
  raw: string;
}

/** Split a dictionary header on top-level commas (quotes and inner lists respected). */
function splitDictionaryMembers(value: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      members.push(value.slice(start, index));
      start = index + 1;
    }
  }
  members.push(value.slice(start));
  return members.map((member) => member.trim()).filter((member) => member !== "");
}

/** Parse `;key=value;...` parameters. Returns null on malformed input. */
function parseParameters(raw: string): Record<string, string | number> | null {
  const params: Record<string, string | number> = {};
  let rest = raw;
  while (rest !== "") {
    if (!rest.startsWith(";")) return null;
    rest = rest.slice(1).trimStart();
    const match = /^([a-z*][a-z0-9_.*-]*)=/.exec(rest);
    if (!match) return null;
    const key = match[1];
    rest = rest.slice(match[0].length);
    if (rest.startsWith('"')) {
      const end = findStringEnd(rest);
      if (end === -1) return null;
      params[key] = unescapeSfString(rest.slice(1, end));
      rest = rest.slice(end + 1);
    } else {
      const valueMatch = /^-?\d+/.exec(rest);
      if (!valueMatch) return null;
      params[key] = Number(valueMatch[0]);
      rest = rest.slice(valueMatch[0].length);
    }
    rest = rest.trimStart();
  }
  return params;
}

function findStringEnd(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === '"') return index;
  }
  return -1;
}

function unescapeSfString(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/**
 * Parse a `Signature-Input` dictionary: `label=("comp" ...);param=...`.
 * Returns null when any member is malformed (fail closed — a partially
 * parsed header must not be verified against).
 */
export function parseSignatureInput(header: string): SignatureInputMember[] | null {
  const members: SignatureInputMember[] = [];
  for (const memberText of splitDictionaryMembers(header)) {
    const eq = memberText.indexOf("=");
    if (eq === -1) return null;
    const label = memberText.slice(0, eq).trim();
    const raw = memberText.slice(eq + 1).trim();
    if (!raw.startsWith("(")) return null;
    const close = raw.indexOf(")");
    if (close === -1) return null;

    const componentsText = raw.slice(1, close).trim();
    const components: string[] = [];
    if (componentsText !== "") {
      for (const item of componentsText.split(/\s+/)) {
        if (!item.startsWith('"') || !item.endsWith('"') || item.length < 2) return null;
        components.push(unescapeSfString(item.slice(1, -1)));
      }
    }

    const params = parseParameters(raw.slice(close + 1).trim());
    if (!params) return null;
    members.push({ label, components, params, raw });
  }
  return members;
}

/** Parse a `Signature` dictionary of byte sequences: `label=:base64:`. */
export function parseSignatureHeader(header: string): Record<string, Uint8Array> | null {
  const signatures: Record<string, Uint8Array> = {};
  for (const memberText of splitDictionaryMembers(header)) {
    const match = /^([^=]+)=:([A-Za-z0-9+/]*={0,2}):$/.exec(memberText.trim());
    if (!match) return null;
    let bytes: Uint8Array;
    try {
      bytes = base64Decode(match[2]);
    } catch {
      return null;
    }
    signatures[match[1].trim()] = bytes;
  }
  return signatures;
}

// ---------------------------------------------------------------------------
// RFC 9421 signature base
// ---------------------------------------------------------------------------

/**
 * Build the signature base for the covered components. Only the derived
 * components an HTTP verifier can compute from a Web `Request` are supported;
 * an unrecognized component fails the whole verification.
 */
export function buildSignatureBase(request: Request, member: SignatureInputMember): string | null {
  const url = new URL(request.url);
  const lines: string[] = [];

  for (const component of member.components) {
    let value: string | null = null;
    if (component.startsWith("@")) {
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
        default:
          return null;
      }
    } else {
      // Header component: RFC 9421 uses the comma-joined, trimmed field value.
      const headerValue = request.headers.get(component);
      if (headerValue === null) return null;
      value = headerValue.trim().replace(/[\r\n]+\s*/g, " ");
    }
    lines.push(`"${component}": ${value}`);
  }

  // The final line reproduces the received serialization (minus the label)
  // byte-for-byte, per RFC 9421 §2.3.
  lines.push(`"@signature-params": ${member.raw}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64Decode(normalized);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 8037 Appendix A.3 JWK thumbprint for an Ed25519 public key: SHA-256
 * over the canonical `{"crv","kty","x"}` JSON, base64url encoded. This is
 * the `keyid` Web Bot Auth agents send.
 */
export async function ed25519JwkThumbprint(x: string): Promise<string> {
  const canonical = JSON.stringify({ crv: "Ed25519", kty: "OKP", x });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

interface ResolvedAgentKey {
  keyId: string;
  /** Base64url raw public key (JWK `x`). */
  x: string;
  /** Agent label for identities resolved from static keys. */
  agent: string | null;
}

/** Directory cache: origin → { keys, expiresAt (ms) }. Per-instance, best effort. */
const directoryCache = new Map<string, { keys: ResolvedAgentKey[]; expiresAt: number }>();

/** Test hook — clears the module-level directory cache. */
export function clearAgentDirectoryCache(): void {
  directoryCache.clear();
}

async function resolveStaticKey(
  keys: WebBotAuthStaticKey[] | undefined,
  keyId: string,
): Promise<ResolvedAgentKey | null> {
  for (const key of keys ?? []) {
    if (typeof key.x !== "string" || key.x === "") continue;
    const kid = key.kid ?? (await ed25519JwkThumbprint(key.x));
    if (kid === keyId) {
      return { keyId, x: key.x, agent: key.agent ?? null };
    }
  }
  return null;
}

/**
 * Fetch and parse an agent's key directory (JWKS) with strict validation:
 * https only, allowlisted origin, no redirects, response size cap, Ed25519
 * OKP keys only, and each key's thumbprint must match its advertised `kid`
 * (when present). Failures return an empty key set — fail closed.
 */
async function fetchAgentDirectory(
  origin: string,
  cacheTtlSeconds: number,
  fetchImpl: typeof fetch,
): Promise<ResolvedAgentKey[]> {
  const cached = directoryCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  let keys: ResolvedAgentKey[] = [];
  try {
    const response = await fetchImpl(`${origin}${SIGNATURE_AGENT_DIRECTORY_PATH}`, {
      redirect: "error",
      signal: AbortSignal.timeout(DIRECTORY_FETCH_TIMEOUT_MS),
      headers: { accept: "application/http-message-signatures-directory+json" },
    });
    if (response.ok) {
      const body = await readBodyWithCap(response, DIRECTORY_MAX_BYTES);
      const parsed: unknown = body === null ? null : JSON.parse(body);
      keys = await parseDirectoryJwks(parsed);
    }
  } catch {
    keys = [];
  }

  directoryCache.set(origin, { keys, expiresAt: Date.now() + cacheTtlSeconds * 1000 });
  return keys;
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
  return new TextDecoder().decode(buffer);
}

/** Parse a JWKS payload into Ed25519 keys keyed by thumbprint. Invalid entries are dropped. */
export async function parseDirectoryJwks(parsed: unknown): Promise<ResolvedAgentKey[]> {
  if (!parsed || typeof parsed !== "object") return [];
  const rawKeys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(rawKeys)) return [];

  const keys: ResolvedAgentKey[] = [];
  for (const entry of rawKeys) {
    if (!entry || typeof entry !== "object") continue;
    const jwk = entry as { kty?: unknown; crv?: unknown; x?: unknown; kid?: unknown };
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") continue;
    const thumbprint = await ed25519JwkThumbprint(jwk.x);
    // A directory advertising a kid that is not the key's thumbprint is
    // malformed per the directory draft — drop the entry.
    if (typeof jwk.kid === "string" && jwk.kid !== thumbprint) continue;
    keys.push({ keyId: thumbprint, x: jwk.x, agent: null });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyAgentSignatureOptions extends WebBotAuthConfig {
  /** Injectable clock (unix seconds) and fetch for tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Verify a Web Bot Auth signature on the request. Resolves to the verified
 * agent identity, or `null` when the request is unsigned or verification
 * fails for any reason (fail closed — this function never throws).
 */
export async function verifyAgentSignature(
  request: Request,
  options: VerifyAgentSignatureOptions,
): Promise<PrachtAgentIdentity | null> {
  try {
    return await verifyAgentSignatureUnsafe(request, options);
  } catch {
    return null;
  }
}

async function verifyAgentSignatureUnsafe(
  request: Request,
  options: VerifyAgentSignatureOptions,
): Promise<PrachtAgentIdentity | null> {
  const signatureInputHeader = request.headers.get("signature-input");
  const signatureHeader = request.headers.get("signature");
  if (!signatureInputHeader || !signatureHeader) return null;

  const members = parseSignatureInput(signatureInputHeader);
  const signatures = parseSignatureHeader(signatureHeader);
  if (!members || !signatures) return null;

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;

  // The Signature-Agent value is an sf-string containing the directory URL.
  const signatureAgentHeader = request.headers.get("signature-agent");
  const agentUrl = signatureAgentHeader ? parseSignatureAgent(signatureAgentHeader) : null;
  if (signatureAgentHeader && !agentUrl) return null;

  for (const member of members) {
    // Only web-bot-auth signatures concern us; other tags are ignored.
    if (member.params.tag !== WEB_BOT_AUTH_TAG) continue;

    const signature = signatures[member.label];
    if (!signature) continue;

    // Required covered components: @authority always; signature-agent
    // whenever the header is present (draft §4.2.1).
    if (!member.components.includes("@authority")) continue;
    if (signatureAgentHeader && !member.components.includes("signature-agent")) continue;

    // Required parameters and freshness window (with clock-skew allowance).
    const { created, expires, keyid, alg } = member.params;
    if (typeof created !== "number" || typeof expires !== "number") continue;
    if (typeof keyid !== "string" || keyid === "") continue;
    if (alg !== undefined && alg !== "ed25519") continue;
    if (expires <= created || expires - created > maxLifetime) continue;
    if (created > now + skew) continue;
    if (expires < now - skew) continue;

    // Key resolution: static keys first, then the allowlisted directory.
    let key = await resolveStaticKey(options.keys, keyid);
    let agentDomain = key?.agent ?? null;
    if (!key && agentUrl) {
      const allowed = (options.directories ?? []).some(
        (directory) => normalizeOrigin(directory) === agentUrl.origin,
      );
      if (allowed) {
        const directoryKeys = await fetchAgentDirectory(
          agentUrl.origin,
          options.directoryCacheTtlSeconds ?? DEFAULT_DIRECTORY_CACHE_TTL_SECONDS,
          options.fetchImpl ?? fetch,
        );
        key = directoryKeys.find((candidate) => candidate.keyId === keyid) ?? null;
      }
    }
    if (!key) continue;
    if (agentUrl) agentDomain = agentUrl.host;

    const base = buildSignatureBase(request, member);
    if (base === null) continue;

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64UrlDecode(key.x)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      toArrayBuffer(signature),
      encoder.encode(base),
    );
    if (valid) {
      return { verified: true, agentDomain, keyId: keyid };
    }
  }

  return null;
}

/** Copy into a fresh ArrayBuffer — some WebCrypto impls reject SharedArrayBuffer views. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Parse the Signature-Agent sf-string into a validated https URL. */
export function parseSignatureAgent(header: string): URL | null {
  const trimmed = header.trim();
  let value = trimmed;
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) return null;
    value = unescapeSfString(trimmed.slice(1, -1));
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
