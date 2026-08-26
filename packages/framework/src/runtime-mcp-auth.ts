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
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type {
  McpAuthConfig,
  McpTokenPrincipal,
  McpTokenVerifier,
  McpTokenVerifierModule,
  ModuleRegistry,
} from "./types.ts";

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
  const token = readBearerToken(request.headers.get("authorization"));

  if (token === null) {
    // No credentials presented. RFC 6750 §3.1: omit `error` so the host reads
    // this as "authenticate", not "your token is bad".
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 401,
        description: "Authorization required. Present an OAuth 2.0 bearer token.",
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
      }),
    };
  }

  let principal: McpTokenPrincipal | null;
  try {
    principal = normalizePrincipal(await verifier(token, { request }));
  } catch {
    // A throwing verifier is a rejection, never an accept. Its message may
    // carry provider internals, so it does not reach the caller.
    principal = null;
  }

  if (!principal) {
    return {
      ok: false,
      response: mcpAuthChallengeResponse(auth, {
        status: 401,
        error: "invalid_token",
        description: "The bearer token is invalid or expired.",
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
 * Parse `Authorization: Bearer <token>`.
 *
 * `null` means "no bearer credentials at all" (no header, or a different
 * scheme); `""` means "a Bearer header that carries no token" — a malformed
 * request rather than an anonymous one. The distinction decides whether the
 * challenge carries `error="invalid_token"`.
 */
export function readBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^\s*Bearer\s*(.*)$/i.exec(header);
  if (!match) return null;
  return match[1].trim();
}

/**
 * A hook can return anything at runtime. Accept only a well-formed principal
 * and freeze it, so what reaches `context.tokenAuth` is a snapshot no later
 * code can mutate into a different identity.
 */
function normalizePrincipal(value: unknown): McpTokenPrincipal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<McpTokenPrincipal>;
  if (typeof candidate.subject !== "string" || candidate.subject === "") return null;

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
      : candidate.claims && typeof candidate.claims === "object"
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
 * capabilities) and looked up across the buckets the Vite plugin globs —
 * `src/server/` first, which is where the docs put it.
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
  for (const modules of [
    registry.dataModules,
    registry.middlewareModules,
    registry.capabilityModules,
  ]) {
    const module = await resolveRegistryModule<McpTokenVerifierModule>(modules, file);
    if (!module) continue;
    if (typeof module.default !== "function") {
      throw new Error(
        `agents.mcp.auth.verify module ${JSON.stringify(file)} has no default-exported function.`,
      );
    }
    return module.default;
  }
  throw new Error(
    `agents.mcp.auth.verify module ${JSON.stringify(file)} is not registered. Put it under ` +
      "src/server/ so the build includes it.",
  );
}

// ---------------------------------------------------------------------------
// Principal surfacing
// ---------------------------------------------------------------------------

const boundTokenContexts = new WeakMap<object, McpTokenPrincipal | null>();

/**
 * Bind the verified principal onto the request context as `context.tokenAuth`.
 *
 * Mirrors the `context.agent` contract: a frozen snapshot on a non-writable,
 * non-configurable framework-owned field, so middleware may derive its own
 * authorization state elsewhere on `context` but cannot rewrite the identity a
 * later capability or audit check sees. Rebinding one context object to a
 * different principal — which would mean an adapter reused a context across
 * requests — throws rather than leaking the previous caller's identity.
 *
 * Callers turn a throw into a 500. Failing the request is the only safe answer:
 * a capability that reads `context.tokenAuth` would otherwise run with the
 * field silently absent.
 */
export function bindMcpTokenContext<TContext>(
  context: TContext,
  principal: McpTokenPrincipal | null,
): TContext {
  if ((typeof context !== "object" || context === null) && typeof context !== "function") {
    return Object.freeze({ tokenAuth: principal }) as TContext;
  }

  const target = context as unknown as object;
  if (boundTokenContexts.has(target)) {
    if (boundTokenContexts.get(target) === principal) return context;
    throw new TypeError(
      "Pracht request contexts cannot be reused across different verified token principals. " +
        "Create a fresh context for each request.",
    );
  }

  const existing = Reflect.getOwnPropertyDescriptor(target, "tokenAuth");
  if (existing || Reflect.has(target, "tokenAuth")) {
    throw new TypeError(
      "Pracht cannot replace an application-owned `tokenAuth` field on the supplied request " +
        "context. The field is reserved for the framework — rename yours.",
    );
  }

  try {
    Object.defineProperty(target, "tokenAuth", {
      configurable: false,
      enumerable: true,
      value: principal,
      writable: false,
    });
  } catch {
    throw new TypeError(
      "Pracht could not bind the verified token principal to a frozen or sealed request context. " +
        "Create a fresh mutable request context for each request.",
    );
  }
  boundTokenContexts.set(target, principal);
  return context;
}

let warnedVerifierUnavailable = false;
function warnVerifierUnavailable(error: unknown): void {
  if (warnedVerifierUnavailable) return;
  warnedVerifierUnavailable = true;
  console.error(
    "[pracht] agents.mcp.auth.verify could not be loaded; /mcp is answering 401 for every request.",
    error,
  );
}
