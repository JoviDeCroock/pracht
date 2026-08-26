import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import { defineApp, handlePrachtRequest, resolveApp, route } from "../src/index.ts";
import {
  isMcpResourceMetadataPath,
  mcpResourceMetadataPath,
  mcpResourceMetadataUrl,
} from "../src/mcp-config.ts";
import type { McpAuthConfig, McpTokenVerifier, ModuleRegistry } from "../src/types.ts";

const ORIGIN = "https://app.example";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

type CapabilityDefinition = Parameters<typeof defineCapability>[0];

/** Records what the capability actually saw, so "surfaced" is observed, not assumed. */
let observedTokenAuth: unknown;
let verifyCalls: string[] = [];

const tokenProbe = defineCapability({
  title: "Token probe",
  description: "Reports the verified token principal the framework surfaced.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"],
  },
  effect: "read",
  expose: { mcp: true },
  async run({ context }) {
    const typed = context as { tokenAuth?: { subject?: string } };
    observedTokenAuth = typed.tokenAuth;
    return { subject: typed.tokenAuth?.subject ?? "(none)" };
  },
} as CapabilityDefinition);

const BASE_AUTH: McpAuthConfig = {
  resource: `${ORIGIN}/mcp`,
  authorizationServers: ["https://auth.example"],
  scopesSupported: ["notes.read", "notes.write"],
  verify: "./server/mcp-token.ts",
};

interface HarnessOptions {
  auth?: McpAuthConfig | null;
  verify?: McpTokenVerifier;
  /** Register no verify module at all, to prove the endpoint fails closed. */
  omitVerifyModule?: boolean;
  mcpPath?: string;
  /** Also configure Web Bot Auth, which wraps frozen contexts in an overlay. */
  webBotAuth?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const auth = options.auth === null ? undefined : (options.auth ?? BASE_AUTH);
  const verify: McpTokenVerifier =
    options.verify ??
    ((token) => {
      verifyCalls.push(token);
      return token === "good" ? { subject: "user-1", scopes: ["notes.read"] } : null;
    });

  const app = defineApp({
    agents: {
      ...(options.webBotAuth ? { webBotAuth: { policy: "observe" as const } } : {}),
      mcp: { ...(options.mcpPath ? { path: options.mcpPath } : {}), auth },
    },
    capabilities: { "token.probe": "./capabilities/token-probe.ts" },
    routes: [route("/", "./routes/home.tsx")],
  });

  const registry: ModuleRegistry = {
    routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
    capabilityModules: {
      "./capabilities/token-probe.ts": async () => ({ default: tokenProbe }),
    } as NonNullable<ModuleRegistry["capabilityModules"]>,
    // `dataModules` is the untyped `src/server/**` glob at runtime; the
    // DataModule typing describes route loaders, not everything the bucket holds.
    dataModules: (options.omitVerifyModule
      ? {}
      : { "./server/mcp-token.ts": async () => ({ default: verify }) }) as NonNullable<
      ModuleRegistry["dataModules"]
    >,
  };

  return { app, registry };
}

interface CallOptions extends HarnessOptions {
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  context?: unknown;
}

async function call(body: unknown, options: CallOptions = {}) {
  const { app, registry } = createHarness(options);
  const method = options.method ?? "POST";
  const request = new Request(`${ORIGIN}${options.path ?? "/mcp"}`, {
    method,
    headers: { "content-type": "application/json", ...options.headers },
    body:
      method === "GET" || method === "HEAD" || method === "OPTIONS"
        ? undefined
        : JSON.stringify(body),
  });
  const response = await handlePrachtRequest({
    app,
    context: options.context,
    registry,
    request,
  });
  const text = await response.clone().text();
  let json: Record<string, any> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, any>) : null;
  } catch {
    // Transport rejections answer in plain text on purpose.
  }
  return { response, status: response.status, text, json };
}

const toolsCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "token_probe" } };

beforeEach(() => {
  observedTokenAuth = undefined;
  verifyCalls = [];
});

describe("protected-resource metadata document", () => {
  it("publishes the RFC 9728 document at the path-inserted well-known URL", async () => {
    const { response, json, status } = await call(null, { method: "GET", path: METADATA_PATH });

    expect(status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: ["https://auth.example"],
      scopes_supported: ["notes.read", "notes.write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("serializes deterministically", async () => {
    const first = await call(null, { method: "GET", path: METADATA_PATH });
    const second = await call(null, { method: "GET", path: METADATA_PATH });
    expect(first.text).toBe(second.text);
    expect(first.text).toBe(
      '{"resource":"https://app.example/mcp","authorization_servers":["https://auth.example"],' +
        '"scopes_supported":["notes.read","notes.write"],"bearer_methods_supported":["header"]}',
    );
  });

  it("also answers the bare well-known root, and one trailing slash", async () => {
    const root = await call(null, {
      method: "GET",
      path: "/.well-known/oauth-protected-resource",
    });
    const slash = await call(null, { method: "GET", path: `${METADATA_PATH}/` });
    expect(root.status).toBe(200);
    expect(slash.status).toBe(200);
    expect(root.text).toBe(slash.text);
  });

  it("is readable without credentials and by browser-based hosts", async () => {
    const { response } = await call(null, { method: "GET", path: METADATA_PATH });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await call(null, { method: "OPTIONS", path: METADATA_PATH });
    expect(preflight.status).toBe(204);
    expect(preflight.response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("rejects non-read methods", async () => {
    const { status, response } = await call(null, { method: "POST", path: METADATA_PATH });
    expect(status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("omits optional members that were not configured", async () => {
    const { json } = await call(null, {
      method: "GET",
      path: METADATA_PATH,
      auth: { ...BASE_AUTH, scopesSupported: undefined },
    });
    expect(json).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: ["https://auth.example"],
      bearer_methods_supported: ["header"],
    });
  });

  it("advertises resource_documentation when configured", async () => {
    const { json } = await call(null, {
      method: "GET",
      path: METADATA_PATH,
      auth: { ...BASE_AUTH, resourceDocumentation: "https://docs.example/mcp" },
    });
    expect(json?.resource_documentation).toBe("https://docs.example/mcp");
  });

  it("is not served at all when the app does not configure auth", async () => {
    const { status } = await call(null, { method: "GET", path: METADATA_PATH, auth: null });
    expect(status).toBe(404);
  });

  it("derives the well-known path from the resource identifier", () => {
    expect(mcpResourceMetadataPath(BASE_AUTH)).toBe(METADATA_PATH);
    expect(mcpResourceMetadataUrl(BASE_AUTH)).toBe(`${ORIGIN}${METADATA_PATH}`);
    expect(
      mcpResourceMetadataPath({ ...BASE_AUTH, resource: "https://app.example/base/agent/mcp" }),
    ).toBe("/.well-known/oauth-protected-resource/base/agent/mcp");
    // A resource identifier with no path publishes at the bare well-known root.
    expect(mcpResourceMetadataPath({ ...BASE_AUTH, resource: "https://app.example" })).toBe(
      "/.well-known/oauth-protected-resource",
    );
    expect(isMcpResourceMetadataPath("/mcp", BASE_AUTH)).toBe(false);
  });
});

describe("WWW-Authenticate challenges", () => {
  it("answers 401 with a resource_metadata pointer when no token is presented", async () => {
    const { status, response, json } = await call(toolsCall);

    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}${METADATA_PATH}"`,
    );
    // RFC 6750 §3.1: no error code when the client sent no credentials.
    expect(json?.error).toBeUndefined();
    expect(json?.resource_metadata).toBe(`${ORIGIN}${METADATA_PATH}`);
    expect(verifyCalls).toEqual([]);
  });

  it("answers 401 invalid_token when a bad token is presented", async () => {
    const { status, response, json } = await call(toolsCall, {
      headers: { authorization: "Bearer nope" },
    });

    expect(status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${ORIGIN}${METADATA_PATH}"`);
    expect(json?.error).toBe("invalid_token");
    expect(verifyCalls).toEqual(["nope"]);
  });

  it("treats a Bearer header with no token as malformed, not anonymous", async () => {
    const { status, response } = await call(toolsCall, { headers: { authorization: "Bearer" } });
    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(verifyCalls).toEqual([]);
  });

  it("ignores a non-Bearer scheme and challenges for one", async () => {
    for (const authorization of [
      "Basic dXNlcjpwYXNz",
      // RFC 7235 requires at least one space after the scheme; without it this
      // is an unknown scheme, not a Bearer credential with a broken token.
      "Bearergood",
      "BearerToken abc",
    ]) {
      const { status, response } = await call(toolsCall, { headers: { authorization } });
      expect(status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${ORIGIN}${METADATA_PATH}"`,
      );
      expect(verifyCalls).toEqual([]);
    }
  });

  it("answers 403 insufficient_scope when the token lacks a required scope", async () => {
    const { status, response, json } = await call(toolsCall, {
      auth: { ...BASE_AUTH, requiredScopes: ["notes.write"] },
      headers: { authorization: "Bearer good" },
    });

    expect(status).toBe(403);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="notes.write"');
    expect(challenge).toContain(`resource_metadata="${ORIGIN}${METADATA_PATH}"`);
    expect(json?.error).toBe("insufficient_scope");
    expect(observedTokenAuth).toBeUndefined();
  });

  it("points the challenge at a custom endpoint's metadata URL", async () => {
    const auth: McpAuthConfig = { ...BASE_AUTH, resource: `${ORIGIN}/agent/mcp` };
    const { response, status } = await call(toolsCall, {
      auth,
      mcpPath: "/agent/mcp",
      path: "/agent/mcp",
    });
    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/agent/mcp"`,
    );
  });
});

describe("fail-closed verification", () => {
  it("rejects when the verify hook throws", async () => {
    const { status, response } = await call(toolsCall, {
      headers: { authorization: "Bearer good" },
      verify: () => {
        throw new Error("jwks unreachable");
      },
    });

    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // The provider's failure text must not reach the caller.
    expect(await response.text()).not.toContain("jwks");
    expect(observedTokenAuth).toBeUndefined();
  });

  it("rejects when the verify hook rejects asynchronously", async () => {
    const { status } = await call(toolsCall, {
      headers: { authorization: "Bearer good" },
      verify: async () => {
        throw new Error("boom");
      },
    });
    expect(status).toBe(401);
  });

  it("rejects a principal without a usable subject", async () => {
    for (const bad of [{}, { subject: "" }, { subject: 42 }, "user-1", []]) {
      const { status } = await call(toolsCall, {
        headers: { authorization: "Bearer good" },
        verify: () => bad as never,
      });
      expect(status).toBe(401);
    }
  });

  it("rejects a principal whose scopes are not strings", async () => {
    const { status } = await call(toolsCall, {
      headers: { authorization: "Bearer good" },
      verify: () => ({ subject: "user-1", scopes: [1, 2] }) as never,
    });
    expect(status).toBe(401);
  });

  it("rejects every request when the verify module is not registered", async () => {
    const { status, response } = await call(toolsCall, {
      headers: { authorization: "Bearer good" },
      omitVerifyModule: true,
    });
    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("runs before capability dispatch — an unknown tool still answers 401", async () => {
    const { status, json } = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "does_not_exist" },
    });
    expect(status).toBe(401);
    // No JSON-RPC envelope: the caller learns nothing about the tool list.
    expect(json?.jsonrpc).toBeUndefined();
  });

  it("runs before tools/list", async () => {
    const { status } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("runs before the body is parsed", async () => {
    const { app, registry } = createHarness();
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    });
    expect(response.status).toBe(401);
  });

  it("keeps the existing transport hardening ahead of the token check", async () => {
    const cookie = await call(toolsCall, { headers: { cookie: "session=1" } });
    expect(cookie.status).toBe(403);
    expect(cookie.response.headers.get("www-authenticate")).toBeNull();

    const browser = await call(toolsCall, { headers: { origin: ORIGIN } });
    expect(browser.status).toBe(403);

    const get = await call(null, { method: "GET" });
    expect(get.status).toBe(405);
  });
});

describe("principal surfacing", () => {
  it("surfaces the verified principal as context.tokenAuth", async () => {
    const { status, json } = await call(toolsCall, { headers: { authorization: "Bearer good" } });

    expect(status).toBe(200);
    expect(json?.result?.structuredContent).toEqual({ subject: "user-1" });
    expect(observedTokenAuth).toEqual({ subject: "user-1", scopes: ["notes.read"] });
  });

  it("binds an immutable snapshot application code cannot rewrite", async () => {
    await call(toolsCall, { headers: { authorization: "Bearer good" } });
    const principal = observedTokenAuth as { subject: string; scopes: string[] };

    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(() => {
      (principal as { subject: string }).subject = "attacker";
    }).toThrow();
    expect(principal.subject).toBe("user-1");
  });

  it("binds onto the adapter-supplied context without replacing it", async () => {
    const context = { tenant: "acme" };
    const { status } = await call(toolsCall, {
      context,
      headers: { authorization: "Bearer good" },
    });

    expect(status).toBe(200);
    expect((context as { tokenAuth?: { subject: string } }).tokenAuth?.subject).toBe("user-1");
    const descriptor = Object.getOwnPropertyDescriptor(context, "tokenAuth")!;
    expect(descriptor.writable).toBe(false);
    expect(descriptor.configurable).toBe(false);
  });

  it("fails closed when the context already owns a tokenAuth field", async () => {
    const { status } = await call(toolsCall, {
      context: { tokenAuth: { subject: "spoofed" } },
      headers: { authorization: "Bearer good" },
    });
    expect(status).toBe(500);
    expect(observedTokenAuth).toBeUndefined();
  });

  it("fails closed when a context is reused across principals", async () => {
    const context: Record<string, unknown> = {};
    const first = await call(toolsCall, { context, headers: { authorization: "Bearer good" } });
    expect(first.status).toBe(200);

    const second = await call(toolsCall, {
      context,
      headers: { authorization: "Bearer good" },
      verify: () => ({ subject: "user-2" }),
    });
    expect(second.status).toBe(500);
  });

  // `createContext: () => sharedObject` is a legal adapter shape. Reference
  // equality on the normalized principal would 500 every request after the
  // first, because each request builds a fresh frozen snapshot.
  it("allows a reused context when the principal is structurally identical", async () => {
    const context: Record<string, unknown> = { tenant: "acme" };
    const verify: McpTokenVerifier = () => ({
      subject: "user-1",
      scopes: ["notes.read"],
      clientId: "cli",
      claims: { org: { id: 7 }, roles: ["admin"] },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { status } = await call(toolsCall, {
        context,
        verify,
        headers: { authorization: "Bearer good" },
      });
      expect(status).toBe(200);
      expect((observedTokenAuth as { subject: string }).subject).toBe("user-1");
    }
  });

  it("still fails closed when a reused context sees the same subject with different claims", async () => {
    const context: Record<string, unknown> = {};
    const first = await call(toolsCall, {
      context,
      headers: { authorization: "Bearer good" },
      verify: () => ({ subject: "user-1", claims: { jti: "a" } }),
    });
    expect(first.status).toBe(200);

    // Stale claims would otherwise be handed to the second request's capability.
    const second = await call(toolsCall, {
      context,
      headers: { authorization: "Bearer good" },
      verify: () => ({ subject: "user-1", claims: { jti: "b" } }),
    });
    expect(second.status).toBe(500);
  });

  it("accepts a frozen context carrying the Web Bot Auth overlay, and rejects a bare frozen one", async () => {
    // Bare frozen object: no overlay exists to hold the field, so the request
    // fails closed rather than dispatching with `tokenAuth` silently absent.
    // This is the documented difference from `context.agent`.
    const bare = await call(toolsCall, {
      context: Object.freeze({ tenant: "acme" }),
      headers: { authorization: "Bearer good" },
    });
    expect(bare.status).toBe(500);
    expect(observedTokenAuth).toBeUndefined();

    // With `agents.webBotAuth` configured, `bindAgentContext()` has already
    // wrapped the frozen context in an extensible overlay, which accepts it.
    const { app, registry } = createHarness({ webBotAuth: true });
    const response = await handlePrachtRequest({
      app,
      context: Object.freeze({ tenant: "acme" }),
      registry,
      request: new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer good" },
        body: JSON.stringify(toolsCall),
      }),
    });
    expect(response.status).toBe(200);
    expect((observedTokenAuth as { subject: string }).subject).toBe("user-1");
  });

  it("rejects a principal whose clientId is not a string", async () => {
    const { status } = await call(toolsCall, {
      headers: { authorization: "Bearer good" },
      verify: () => ({ subject: "user-1", clientId: 42 }) as never,
    });
    expect(status).toBe(401);
  });

  it("passes the transport request to the verify hook", async () => {
    let seenUrl: string | undefined;
    await call(toolsCall, {
      headers: { authorization: "Bearer good" },
      verify: (_token, args) => {
        seenUrl = args.request.url;
        return { subject: "user-1" };
      },
    });
    expect(seenUrl).toBe(`${ORIGIN}/mcp`);
  });
});

describe("manifest validation", () => {
  // Validation lives in resolveApp(), so it also runs in production server
  // bundles — not only where `import.meta.env.DEV` survives.
  const build = (auth: unknown, path?: string) => () =>
    resolveApp(
      defineApp({
        agents: { mcp: { ...(path ? { path } : {}), auth: auth as McpAuthConfig } },
        routes: [route("/", "./routes/home.tsx")],
      }),
    );

  it("rejects a relative resource identifier", () => {
    expect(build({ ...BASE_AUTH, resource: "/mcp" })).toThrow(/absolute URL/);
  });

  it("rejects a resource identifier carrying a query or fragment", () => {
    expect(build({ ...BASE_AUTH, resource: `${ORIGIN}/mcp?x=1` })).toThrow(/query string/);
    expect(build({ ...BASE_AUTH, resource: `${ORIGIN}/mcp#f` })).toThrow(/fragment/);
  });

  it("rejects a resource identifier that does not address the served endpoint", () => {
    expect(build({ ...BASE_AUTH, resource: `${ORIGIN}/mcp` }, "/agent/mcp")).toThrow(
      /does not address the MCP endpoint/,
    );
    // A deploy base belongs in front of the endpoint path: the resource is the
    // endpoint's real deployed URL, base included. RFC 9728 then puts the
    // document at the origin root with the base inside the suffix.
    expect(
      build({ ...BASE_AUTH, resource: `${ORIGIN}/app/agent/mcp` }, "/agent/mcp"),
    ).not.toThrow();
  });

  it("requires at least one authorization server", () => {
    expect(build({ ...BASE_AUTH, authorizationServers: [] })).toThrow(/at least one/);
    expect(build({ ...BASE_AUTH, authorizationServers: ["auth.example"] })).toThrow(/absolute URL/);
  });

  it("rejects scope tokens that would break the challenge header", () => {
    expect(build({ ...BASE_AUTH, scopesSupported: ["a b"] })).toThrow(/scope tokens/);
    expect(build({ ...BASE_AUTH, requiredScopes: ['a"b'] })).toThrow(/scope tokens/);
  });

  it("requires a verify module reference", () => {
    expect(build({ ...BASE_AUTH, verify: undefined })).toThrow(/server-only module/);
  });

  it("accepts a well-formed config", () => {
    expect(build(BASE_AUTH)).not.toThrow();
  });
});

describe("zero cost when unconfigured", () => {
  it("leaves an unauthenticated MCP endpoint untouched", async () => {
    const { status, json, response } = await call(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { auth: null },
    );
    expect(status).toBe(200);
    expect(json?.result?.tools?.[0]?.name).toBe("token_probe");
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

/**
 * RFC 9728 §3.1 inserts the well-known segment between the host and the
 * resource's path, so an app deployed under `/app/` publishes at the **origin
 * root** — `/.well-known/oauth-protected-resource/app/mcp` — with the base
 * inside the suffix rather than in front of it. That URL is outside the deploy
 * base by construction, so it has to be recognised before `stripBase()`, which
 * answers `null` for it and would otherwise 404 the exact URL the challenge
 * tells hosts to fetch.
 */
describe("under a deploy base", () => {
  const BASE = "/app/";
  const BASED_AUTH: McpAuthConfig = {
    resource: `${ORIGIN}/app/mcp`,
    authorizationServers: ["https://auth.example"],
    verify: "./server/mcp-token.ts",
  };

  async function loadUnderBase() {
    vi.resetModules();
    vi.stubEnv("BASE_URL", BASE);
    const core = await import("../src/index.ts");
    const app = core.defineApp({
      agents: { mcp: { auth: BASED_AUTH } },
      capabilities: { "token.probe": "./capabilities/token-probe.ts" },
      routes: [core.route("/", "./routes/home.tsx")],
    });
    const registry = {
      routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
      capabilityModules: {
        "./capabilities/token-probe.ts": async () => ({ default: tokenProbe }),
      },
      dataModules: {
        "./server/mcp-token.ts": async () => ({
          default: (token: string) => (token === "good" ? { subject: "user-1" } : null),
        }),
      },
    } as unknown as ModuleRegistry;

    const fetchPath = (path: string, init?: RequestInit) =>
      core.handlePrachtRequest({
        app,
        registry,
        request: new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toolsCall),
          ...init,
        }),
      });

    return { fetchPath };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("advertises a metadata URL that is actually fetchable", async () => {
    const { fetchPath } = await loadUnderBase();

    const challenged = await fetchPath("/app/mcp");
    expect(challenged.status).toBe(401);
    const challenge = challenged.headers.get("www-authenticate") ?? "";
    const advertised = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(advertised).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/app/mcp`);

    // The point of the fix: fetch exactly what the challenge advertised.
    const metadata = await fetchPath(new URL(advertised!).pathname, {
      method: "GET",
      body: undefined,
    });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: `${ORIGIN}/app/mcp`,
      authorization_servers: ["https://auth.example"],
      bearer_methods_supported: ["header"],
    });
  });

  it("also answers the bare well-known root at the origin root", async () => {
    const { fetchPath } = await loadUnderBase();
    const response = await fetchPath("/.well-known/oauth-protected-resource", {
      method: "GET",
      body: undefined,
    });
    expect(response.status).toBe(200);
  });

  it("tolerates a proxy that re-prefixes the base onto the well-known path", async () => {
    const { fetchPath } = await loadUnderBase();
    const response = await fetchPath("/app/.well-known/oauth-protected-resource/app/mcp", {
      method: "GET",
      body: undefined,
    });
    expect(response.status).toBe(200);
  });

  it("still serves and guards the endpoint itself under the base", async () => {
    const { fetchPath } = await loadUnderBase();
    const authorized = await fetchPath("/app/mcp", {
      headers: { "content-type": "application/json", authorization: "Bearer good" },
    });
    expect(authorized.status).toBe(200);
    expect((await authorized.json()).result.structuredContent).toEqual({ subject: "user-1" });
  });
});
