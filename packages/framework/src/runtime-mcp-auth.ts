/**
 * OAuth 2.0 resource-server surface for the remote MCP endpoint.
 *
 * Pracht is the *resource server* and nothing else. It publishes what
 * [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) calls protected-resource
 * metadata, answers unauthenticated calls with the `WWW-Authenticate` challenge
 * the MCP authorization spec (revision 2025-06-18) tells hosts to follow, and
 * hands the presented token to an application-supplied `verify` hook. It never
 * validates a JWT, fetches a JWKS, mints a token, or becomes an authorization
 * server — those belong to an identity provider, and the hook is the seam.
 *
 * Everything here is Web-platform only (`Request`, `Response`, `URL`), so the
 * Node, Cloudflare, Netlify, and Vercel adapters share one implementation.
 *
 * Loaded lazily from `runtime-mcp.ts`: an app that serves MCP without
 * `agents.mcp.auth` never imports this module.
 */

import { mcpResourceMetadataUrl } from "./mcp-config.ts";
import { normalizeModulePath } from "./runtime-manifest.ts";
import type {
  McpAuthConfig,
  McpTokenPrincipal,
  McpTokenVerifier,
  McpTokenVerifierModule,
  ModuleImporter,
  ModuleRegistry,
} from "./types.ts";

export { bindMcpTokenContext } from "./runtime-agent-context.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

// ---------------------------------------------------------------------------
// Metadata document
// ---------------------------------------------------------------------------

/**
 * The RFC 9728 document, built in a fixed key order so the response body is
 * byte-stable across requests and deployments (caches and integrity checks
 * both care, and a diffable body is easier to reason about).
 */
export function mcpResourceMetadataDocument(auth: McpAuthConfig): Record<string, unknown> {
  const document: Record<string, unknown> = {
    resource: auth.resource,
    authorization_servers: [...auth.authorizationServers],
  };
  if (auth.scopesSupported?.length) document.scopes_supported = [...auth.scopesSupported];
  // Pracht only reads the `Authorization` header — never a form field or query
  // parameter, both of which RFC 6750 discourages and neither of which the MCP
  // transport uses.
  document.bearer_methods_supported = ["header"];
  if (auth.resourceDocumentation) document.resource_documentation = auth.resourceDocumentation;
  return document;
}

/**
 * Serve `/.well-known/oauth-protected-resource`.
 *
 * Deliberately unauthenticated and CORS-open: discovery is what a host does
 * *before* it has a token, and the document contains only identifiers the
 * server publishes on purpose. Browser-based MCP clients (Inspector, in-page
 * hosts) cannot read it otherwise.
 */
export function handleMcpResourceMetadataRequest(request: Request, auth: McpAuthConfig): Response {
  const method = request.method.toUpperCase();
  const headers: Record<string, string> = {
    ...JSON_HEADERS,
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=3600",
  };

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "mcp-protocol-version",
        "access-control-max-age": "86400",
      },
    });
  }

  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const body = JSON.stringify(mcpResourceMetadataDocument(auth));
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

interface ChallengeOptions {
  /** RFC 6750 error code. Omitted when the client sent no credentials at all. */
  error?: "invalid_token" | "insufficient_scope";
  description: string;
  status: 401 | 403;
  /** Advertised on an `insufficient_scope` challenge so the host can re-request. */
  scope?: readonly string[];
}

/**
 * Build the `WWW-Authenticate` challenge the MCP authorization spec requires.
 *
 * `resource_metadata` is the whole point: it is how a host that has never seen
 * this server discovers which authorization server to talk to. The parameter
 * values are quoted strings, and every value that reaches them is either
 * framework-controlled or already validated by `defineApp()` to contain no
 * quote or backslash, so no escaping ambiguity survives.
 */
export function mcpAuthChallengeResponse(auth: McpAuthConfig, options: ChallengeOptions): Response {
  const metadataUrl = mcpResourceMetadataUrl(auth);
  const parameters = [`resource_metadata="${metadataUrl}"`];
  if (options.error) {
    parameters.unshift(`error="${options.error}"`, `error_description="${options.description}"`);
  }
  if (options.scope?.length) {
    parameters.push(`scope="${options.scope.join(" ")}"`);
  }

  const body: Record<string, unknown> = { error_description: options.description };
  if (options.error) body.error = options.error;
  body.resource_metadata = metadataUrl;

  return new Response(JSON.stringify(body), {
    status: options.status,
    headers: {
      ...JSON_HEADERS,
      "www-authenticate": `Bearer ${parameters.join(", ")}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

export type McpAuthResult =
  | { ok: true; principal: McpTokenPrincipal }
  | { ok: false; response: Response };

/**
 * Authenticate one MCP transport request. Fails closed at every step: a
 * missing, malformed, unverifiable, or under-scoped token never reaches
 * capability dispatch, and neither does a `verify` hook that throws or returns
 * something that is not a principal.
 */
export async function authenticateMcpRequest(options: {
  auth: McpAuthConfig;
  registry: ModuleRegistry;
  request: Request;
}): Promise<McpAuthResult> {
  const { auth, request } = options;
  const canonicalRedirect = redirectToCanonicalMcpResource(request, auth);
  if (canonicalRedirect) return { ok: false, response: canonicalRedirect };

  const token = readBearerToken(request.headers.get("authorization"));

  if (token === null) {
    // No credentials presented. RFC 6750 §3.1: omit `error` so the host reads
    // this as "authenticate", not "your token is bad".
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 401,
        description: "Authorization required. Present an OAuth 2.0 bearer token.",
        scope: auth.requiredScopes,
      }),
    };
  }
  if (token === "") {
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 401,
        error: "invalid_token",
        description: "Malformed Authorization header.",
        scope: auth.requiredScopes,
      }),
    };
  }

  let verifier: McpTokenVerifier;
  try {
    verifier = await loadMcpTokenVerifier(auth, options.registry);
  } catch (error: unknown) {
    // A configured-but-unloadable verifier must not serve tools unguarded.
    warnVerifierUnavailable(error);
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 401,
        error: "invalid_token",
        description: "Token verification is unavailable.",
        scope: auth.requiredScopes,
      }),
    };
  }

  let principal: McpTokenPrincipal | null;
  try {
    // A verifier may inspect the JSON-RPC body for tenant-aware token checks.
    // Give it an independent stream so consuming that body cannot turn the
    // later protocol parse into a spurious JSON-RPC parse error.
    principal = normalizePrincipal(await verifier(token, { request: request.clone() }));
  } catch (error: unknown) {
    // A throwing verifier is a rejection, never an accept. Its message may
    // carry provider internals, so it does not reach the caller.
    warnVerifierRejected(error);
    principal = null;
  }

  if (!principal) {
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 401,
        error: "invalid_token",
        description: "The bearer token is invalid or expired.",
        scope: auth.requiredScopes,
      }),
    };
  }

  const missing = (auth.requiredScopes ?? []).filter(
    (scope) => !principal!.scopes?.includes(scope),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 403,
        error: "insufficient_scope",
        description: `The token is missing required scope(s): ${missing.join(" ")}.`,
        scope: auth.requiredScopes,
      }),
    };
  }

  return { ok: true, principal };
}

/**
 * RFC 9728 requires challenged metadata to name exactly the URL the client
 * used for the protected-resource request. Redirect any alias, query-bearing,
 * or trailing-slash spelling before emitting a challenge that a conforming
 * client would have to discard. Status 308 preserves the MCP POST body.
 */
function redirectToCanonicalMcpResource(request: Request, auth: McpAuthConfig): Response | null {
  if (new URL(request.url).href === new URL(auth.resource).href) return null;
  return new Response("Redirecting to the canonical MCP resource.", {
    status: 308,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      location: auth.resource,
    },
  });
}

/**
 * Parse `Authorization: Bearer <token>`.
 *
 * `null` means "no bearer credentials at all" (no header, or a different
 * scheme); `""` means "a Bearer header that carries no token" — a malformed
 * request rather than an anonymous one. The distinction decides whether the
 * challenge carries `error="invalid_token"`.
 */
export function readBearerToken(header: string | null): string | null {
  if (!header) return null;
  // RFC 7235: `credentials = auth-scheme [ 1*SP token68 ]`. At least one space
  // is required, so `Bearerabc` is a different (unknown) scheme, not a token —
  // matching it would let an unparseable header look like a rejected one.
  const match = /^\s*Bearer(?:\s+(.*))?$/i.exec(header);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

/**
 * A hook can return anything at runtime. Accept only a well-formed principal
 * and freeze it, so what reaches `context.tokenAuth` is a snapshot no later
 * code can mutate into a different identity.
 *
 * `claims` is frozen **shallowly**: its own keys cannot be added, removed, or
 * rewritten, but nested values are whatever the verifier returned and stay
 * mutable. Deep-freezing would reach into objects the application still owns
 * (a `jose` JWT payload, say). The framework never reads `claims`, so this only
 * affects application code, and the documentation says so.
 */
function normalizePrincipal(value: unknown): McpTokenPrincipal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<McpTokenPrincipal>;
  if (typeof candidate.subject !== "string" || candidate.subject === "") return null;
  if (
    candidate.clientId !== undefined &&
    candidate.clientId !== null &&
    typeof candidate.clientId !== "string"
  ) {
    return null;
  }

  const scopes =
    candidate.scopes === undefined
      ? undefined
      : Array.isArray(candidate.scopes) && candidate.scopes.every((s) => typeof s === "string")
        ? Object.freeze([...candidate.scopes])
        : null;
  if (scopes === null) return null;

  const claims =
    candidate.claims === undefined
      ? undefined
      : candidate.claims && typeof candidate.claims === "object" && !Array.isArray(candidate.claims)
        ? Object.freeze({ ...candidate.claims })
        : null;
  if (claims === null) return null;

  return Object.freeze({
    subject: candidate.subject,
    ...(scopes ? { scopes } : {}),
    ...(candidate.clientId === undefined ? {} : { clientId: candidate.clientId ?? null }),
    ...(claims ? { claims } : {}),
  }) as McpTokenPrincipal;
}

/**
 * Resolve the `verify` module from the registry. The verifier is server-only
 * code, so it is registered as a module reference (like middleware and
 * capabilities) and looked up across every bucket the Vite plugin globs. A
 * suffix that identifies more than one module is rejected instead of letting
 * registry bucket order choose which security hook runs.
 *
 * Not memoized: the registry entry is an `import.meta.glob` thunk, so the ES
 * module cache already makes the second call free, and a framework-level cache
 * would silently pin the first registry a config object was ever seen with.
 */
export async function loadMcpTokenVerifier(
  auth: McpAuthConfig,
  registry: ModuleRegistry,
): Promise<McpTokenVerifier> {
  const file = auth.verify;
  if (typeof file !== "string") {
    throw new Error(
      "agents.mcp.auth.verify must be a module path. Ensure the Vite plugin rewrites inline " +
        '`() => import("./server/mcp-token.ts")` refs in the app manifest.',
    );
  }
  const importer = resolveMcpTokenVerifierImporter(file, registry);
  const module = (await importer()) as McpTokenVerifierModule;
  if (typeof module.default !== "function") {
    throw new Error(
      `agents.mcp.auth.verify module ${JSON.stringify(file)} has no default-exported function.`,
    );
  }
  return module.default;
}

interface VerifierModuleCandidate {
  key: string;
  importer: ModuleImporter;
}

function resolveMcpTokenVerifierImporter(file: string, registry: ModuleRegistry): ModuleImporter {
  const candidates = new Map<string, VerifierModuleCandidate>();
  for (const modules of [
    registry.dataModules,
    registry.middlewareModules,
    registry.capabilityModules,
  ]) {
    for (const [key, importer] of Object.entries(modules ?? {})) {
      // Configurable source directories may overlap, so one physical module can
      // be present in more than one generated glob. That is not ambiguity: all
      // of those entries import the same file.
      const normalized = normalizeModulePath(key);
      if (!candidates.has(normalized)) candidates.set(normalized, { key, importer });
    }
  }

  const target = normalizeModulePath(file);
  const uniqueCandidates = [...candidates.values()];
  const exact = uniqueCandidates.filter(
    ({ key }) => key === file || normalizeModulePath(key) === target,
  );
  const matches =
    exact.length > 0
      ? exact
      : uniqueCandidates.filter(({ key }) => normalizeModulePath(key).endsWith(`/${target}`));

  if (matches.length === 1) return matches[0]!.importer;
  if (matches.length > 1) {
    throw new Error(
      `agents.mcp.auth.verify module ${JSON.stringify(file)} is ambiguous; it matches ${matches
        .map(({ key }) => JSON.stringify(key))
        .join(", ")}. Use a root-relative module path such as "/src/server/mcp-token.ts".`,
    );
  }
  throw new Error(
    `agents.mcp.auth.verify module ${JSON.stringify(file)} is not registered. Put it under ` +
      "src/server/ so the build includes it.",
  );
}

// ---------------------------------------------------------------------------
// Principal surfacing
// ---------------------------------------------------------------------------

/**
 * Bind the verified principal onto the request context as `context.tokenAuth`:
 * a frozen snapshot on a non-writable, non-configurable framework-owned field.
 * Middleware may derive its own authorization state elsewhere on `context`, but
 * cannot rewrite the identity a later capability or audit check sees.
 *
 * The field lives on a fresh request-local overlay rather than the supplied
 * object. An adapter may therefore reuse a base context without leaving the
 * first MCP caller's principal visible to later page, API, or MCP requests.
 *
 * Callers turn a throw into a 500. Failing the request is the only safe answer:
 * a capability that reads `context.tokenAuth` would otherwise run with the
 * field silently absent.
 */
let warnedVerifierUnavailable = false;
function warnVerifierUnavailable(error: unknown): void {
  if (warnedVerifierUnavailable) return;
  warnedVerifierUnavailable = true;
  console.error(
    "[pracht] agents.mcp.auth.verify could not be loaded; /mcp is answering 401 for every request.",
    error,
  );
}

let warnedVerifierRejected = false;
function warnVerifierRejected(error: unknown): void {
  if (warnedVerifierRejected) return;
  warnedVerifierRejected = true;
  console.error(
    "[pracht] agents.mcp.auth.verify threw while checking a bearer token; the request was rejected.",
    error,
  );
}
