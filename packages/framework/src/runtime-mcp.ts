/**
 * Remote MCP projection: stateless Streamable HTTP over the capability graph.
 *
 * This module is a *transport adapter*, not a second dispatch path. It parses
 * JSON-RPC, projects `expose.mcp` capabilities into `tools/list`, and hands
 * `tools/call` to `handleCapabilityRequest()` — the exact function the
 * generated `/api/capabilities/*` endpoints use. Input validation, named
 * middleware, Web Bot Auth policy, output validation, and audit events are
 * therefore identical across HTTP, WebMCP, and MCP by construction; there is
 * no enforcement in this file to drift.
 *
 * Stateless by design: no session id, no server→client stream, no
 * resumability. That is the profile the Node, Cloudflare, and Vercel adapters
 * already serve, and what the MCP stateless core allows.
 *
 * Serving is opt-in via `defineApp({ agents: { mcp: {} } })`; apps that do not
 * configure it never reach this module.
 */

import {
  CONFIRMATION_HEADER,
  findMcpToolNameCollisions,
  isValidMcpToolName,
  MCP_CAPABILITY_META_KEY,
  MCP_CONFIRMATION_META_KEY,
  MCP_EFFECT_META_KEY,
  MCP_ERROR_META_KEY,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  MCP_STATUS_META_KEY,
  MCP_TOOL_NAME_ERROR,
  mcpToolName,
} from "@pracht/capabilities";
import {
  handleCapabilityRequest,
  setActiveCapabilityHost,
  type CapabilityHostApp,
  type ResolvedCapability,
} from "./runtime-capabilities.ts";
export { resolveMcpEndpoint } from "./mcp-config.ts";
import type {
  CapabilityAuditHook,
  CapabilityEnvelope,
  McpProjectionConfig,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
} from "./types.ts";

// The wire names live in `@pracht/capabilities` alongside the HTTP path
// formula and the confirmation header, so the transport the CLI's eval runner
// speaks cannot drift from the one this projection serves. Re-exported here
// because they have always been part of `@pracht/core`'s public surface.
export {
  MCP_CONFIRMATION_META_KEY,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
} from "@pracht/capabilities";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

/** Normalize an incoming MCP request path without retaining protocol helpers in unrelated apps. */
export function normalizeMcpRequestPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Capabilities the MCP projection serves, in graph order. */
export function mcpExposedCapabilities(
  capabilities: readonly ResolvedCapability[],
): ResolvedCapability[] {
  return capabilities.filter(
    // Destructive capabilities cannot declare `expose.mcp` today (the registry
    // rejects it). The second check is defense in depth: a hand-rolled
    // capability object must not be able to reach agents without the
    // prepare/commit flow a host cannot be trusted to carry.
    (entry) => entry.capability.expose?.mcp === true && entry.capability.effect !== "destructive",
  );
}

export interface HandleMcpRequestOptions<TContext> {
  app: CapabilityHostApp;
  capabilities: readonly ResolvedCapability[];
  context: TContext;
  registry: ModuleRegistry;
  request: Request;
  url: URL;
  exposeErrors: boolean;
  mcp: McpProjectionConfig;
  agents?: PrachtAgentsConfig;
  agent?: PrachtAgentIdentity | null;
  apiMiddlewareFiles?: string[];
  onAudit?: CapabilityAuditHook;
  /** Registry resolution failure captured by the outer application runtime. */
  resolutionError?: unknown;
}

/**
 * Handle one request to the MCP endpoint. Always resolves — protocol problems
 * become JSON-RPC errors, capability problems become tool errors.
 */ export async function handleMcpRequest<TContext>(
  options: HandleMcpRequestOptions<TContext>,
): Promise<Response> {
  const { request } = options;

  // A GET would open the server→client SSE stream. A stateless server has
  // nothing to push, and the spec allows answering 405.
  if (request.method.toUpperCase() !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  // DNS-rebinding protection: remote MCP has no browser use case, so reject
  // browser provenance instead of comparing Origin to `request.url`. Adapters
  // may derive that URL from the attacker-controlled Host header, which makes
  // a same-origin comparison bypassable after DNS rebinding. Ordinary MCP
  // clients send neither header and are unaffected.
  if (!isNonBrowserRequest(request)) {
    return new Response("Browser-originated requests are not allowed", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Adapters may have already derived `context` from the original request
  // (for example via a createContext factory that decodes session cookies).
  // Dropping the header only from the synthesized capability request would
  // therefore be too late: the authenticated context could still authorize
  // the call. Reject ambient browser credentials at the transport boundary.
  if (request.headers.has("cookie")) {
    return new Response("Cookie-authenticated requests are not allowed", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const declaredVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
  // Clients send the negotiated version on every request after initialize;
  // before that (and on the initialize call itself) the newest supported
  // version is the honest answer until `initialize` narrows it below.
  let activeVersion =
    declaredVersion && isSupportedProtocolVersion(declaredVersion)
      ? declaredVersion
      : MCP_LATEST_PROTOCOL_VERSION;
  const respond = (status: number, payload: unknown): Response =>
    jsonRpcResponse(status, activeVersion, payload);

  if (declaredVersion && !isSupportedProtocolVersion(declaredVersion)) {
    return respond(400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSONRPC_INVALID_REQUEST,
        message:
          `Unsupported MCP protocol version ${JSON.stringify(declaredVersion)}. ` +
          `Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}.`,
      },
    });
  }

  if (!acceptsJson(request)) {
    return respond(406, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Client must accept application/json." },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return respond(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_PARSE_ERROR, message: "Parse error." },
    });
  }

  // JSON-RPC batching was removed from MCP; reject it rather than
  // half-supporting it.
  if (Array.isArray(payload)) {
    return respond(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "JSON-RPC batching is not supported." },
    });
  }

  const message = payload as {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return respond(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request." },
    });
  }

  // Notifications omit the id and get no body. MCP request ids are strings or
  // numbers; JSON-RPC's discouraged null id is not a valid MCP RequestId.
  if (message.id === undefined) {
    return new Response(null, { status: 202 });
  }
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    return respond(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request id." },
    });
  }
  const id = message.id;

  if (options.resolutionError !== undefined) {
    const detail =
      options.exposeErrors && options.resolutionError instanceof Error
        ? `: ${options.resolutionError.message}`
        : ".";
    return respond(200, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INTERNAL_ERROR,
        message: `Capability registry failed to resolve${detail}`,
      },
    });
  }

  const exposedCapabilities = mcpExposedCapabilities(options.capabilities);
  const invalidToolNames = exposedCapabilities.filter(
    (entry) => !isValidMcpToolName(mcpToolName(entry.name)),
  );
  if (invalidToolNames.length > 0) {
    return respond(200, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INTERNAL_ERROR,
        message:
          `${MCP_TOOL_NAME_ERROR}: ` +
          invalidToolNames.map((entry) => `${entry.name} → ${mcpToolName(entry.name)}`).join("; "),
      },
    });
  }

  const collisions = findMcpToolNameCollisions(exposedCapabilities.map((entry) => entry.name));
  if (collisions.length > 0) {
    // `pracht verify` reports this at build time; refuse to serve an
    // ambiguous tool list rather than picking a winner at random.
    return respond(200, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INTERNAL_ERROR,
        message:
          "Capability names collide as MCP tool names: " +
          collisions
            .map((collision) => `${collision.capabilities.join(" / ")} → ${collision.toolName}`)
            .join("; "),
      },
    });
  }

  switch (message.method) {
    case "initialize": {
      const params = readInitializeParams(message.params);
      if (!params) {
        return respond(200, {
          jsonrpc: "2.0",
          id,
          error: {
            code: JSONRPC_INVALID_PARAMS,
            message:
              "initialize requires a string protocolVersion, object capabilities, and clientInfo with string name and version.",
          },
        });
      }
      activeVersion = negotiateProtocolVersion(params.protocolVersion);
      return respond(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: activeVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: options.mcp.serverInfo ?? { name: "pracht", version: "0.0.0" },
          instructions: options.mcp.instructions,
        },
      });
    }

    case "ping":
      return respond(200, { jsonrpc: "2.0", id, result: {} });

    case "tools/list":
      return respond(200, {
        jsonrpc: "2.0",
        id,
        result: { tools: mcpExposedCapabilities(options.capabilities).map(toolDescriptor) },
      });

    case "tools/call":
      return handleToolsCall(options, id, message.params, activeVersion);

    default:
      return respond(200, {
        jsonrpc: "2.0",
        id,
        error: {
          code: JSONRPC_METHOD_NOT_FOUND,
          message: `Method not found: ${message.method}`,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------
function toolDescriptor(entry: ResolvedCapability) {
  const { capability } = entry;
  return {
    name: mcpToolName(entry.name),
    title: capability.title,
    description: capability.description,
    inputSchema: capability.input,
    outputSchema: capability.output,
    // Client UX hints, never enforcement — the effect class that produced
    // them is what the server actually enforces.
    annotations: {
      readOnlyHint: capability.effect === "read",
      // `write` only says the capability mutates state; it does not prove the
      // operation is additive. Omit the hint so MCP's conservative default
      // applies unless Pracht grows a more precise effect classification.
      ...(capability.effect === "read" ? { destructiveHint: false } : {}),
      idempotentHint: capability.effect === "read",
    },
    _meta: { [MCP_CAPABILITY_META_KEY]: entry.name, [MCP_EFFECT_META_KEY]: capability.effect },
  };
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

async function handleToolsCall<TContext>(
  options: HandleMcpRequestOptions<TContext>,
  id: string | number,
  rawParams: unknown,
  // Threaded rather than defaulted: `tools/call` is the method that does the
  // work, so it is the one that most needs to agree with the version the
  // client negotiated.
  protocolVersion: string,
): Promise<Response> {
  const params = (rawParams ?? {}) as {
    name?: unknown;
    arguments?: unknown;
    _meta?: Record<string, unknown>;
  };

  if (typeof params.name !== "string") {
    return jsonRpcResponse(200, protocolVersion, {
      jsonrpc: "2.0",
      id,
      error: { code: JSONRPC_INVALID_PARAMS, message: "tools/call requires a string `name`." },
    });
  }
  if (
    params.arguments !== undefined &&
    (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))
  ) {
    return jsonRpcResponse(200, protocolVersion, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INVALID_PARAMS,
        message: "tools/call `arguments` must be an object when provided.",
      },
    });
  }

  const exposed = mcpExposedCapabilities(options.capabilities);
  const match = exposed.find((entry) => mcpToolName(entry.name) === params.name);
  if (!match) {
    // An unknown tool is a protocol-level error, not a tool execution failure.
    return jsonRpcResponse(200, protocolVersion, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INVALID_PARAMS,
        message:
          `Unknown tool ${JSON.stringify(params.name)}. Known tools: ` +
          `${exposed.map((entry) => mcpToolName(entry.name)).join(", ") || "(none)"}.`,
      },
    });
  }

  const capabilityRequest = synthesizeCapabilityRequest(
    options,
    match,
    params.arguments,
    params._meta,
  );
  // `invokeCapability()` resolves its host by Request identity. MCP dispatch
  // uses a synthesized request so middleware and capability bodies see the
  // projected URL and credential policy; bind that request to the same app
  // host before either can compose another capability. The host records the
  // originating transport and verified identity, so nested policy cannot be
  // bypassed with caller-supplied context and composed work audits as
  // `via: "mcp"` rather than looking like an ordinary server call.
  setActiveCapabilityHost(
    capabilityRequest,
    options.app,
    options.registry,
    "mcp",
    options.onAudit,
    options.agent ?? null,
  );
  const capabilityUrl = new URL(capabilityRequest.url);
  const response = await handleCapabilityRequest({
    match,
    context: options.context,
    registry: options.registry,
    request: capabilityRequest,
    url: capabilityUrl,
    pathname: capabilityUrl.pathname,
    exposeErrors: options.exposeErrors,
    apiMiddlewareFiles: options.apiMiddlewareFiles,
    agents: options.agents,
    agent: options.agent ?? null,
    transport: "mcp",
    onAudit: options.onAudit,
  });

  let envelope: CapabilityEnvelope;
  try {
    const parsed: unknown = await response.json();
    if (!isCapabilityEnvelope(parsed)) throw new Error("Response is not a capability envelope.");
    envelope = parsed;
  } catch {
    // Middleware short-circuited with something that is not an envelope (a
    // login redirect, say). Meaningless to an MCP client, and its body may not
    // be safe to forward — report the status as a tool error instead.
    envelope = {
      ok: false,
      error: {
        code: "middleware_rejected",
        message: `Capability "${match.name}" was rejected before it ran (status ${response.status}).`,
      },
    };
  }

  return jsonRpcResponse(200, protocolVersion, {
    jsonrpc: "2.0",
    id,
    result: toolResult(match, envelope, response.status),
  });
}

/**
 * Build the request the HTTP projection would have received.
 *
 * The header policy is a security decision, not plumbing: `cookie` is
 * deliberately **not** copied, so a browser session cookie can never
 * authenticate the remote agent transport — the rule becomes a mechanism
 * rather than a convention. `authorization` is forwarded so middleware sees
 * the MCP credential.
 */
function synthesizeCapabilityRequest<TContext>(
  options: HandleMcpRequestOptions<TContext>,
  match: ResolvedCapability,
  args: unknown,
  meta: Record<string, unknown> | undefined,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const authorization = options.request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const confirmation = meta?.[MCP_CONFIRMATION_META_KEY];
  if (typeof confirmation === "string" && confirmation !== "") {
    headers.set(CONFIRMATION_HEADER, confirmation);
  }
  // Capabilities exposed only over MCP have no HTTP path; a stable internal
  // URL keeps `request.url` meaningful for middleware without opening an
  // endpoint.
  const path = match.httpPath ?? `/__pracht/mcp/tools/${mcpToolName(match.name)}`;
  return new Request(new URL(path, options.url.origin).href, {
    method: "POST",
    headers,
    body: JSON.stringify(args ?? {}),
  });
}

/**
 * Envelope → MCP tool result.
 *
 * Execution failures stay `isError: true` results rather than JSON-RPC errors:
 * the call itself succeeded, and the model needs to *read* the failure to
 * react to it.
 */
function toolResult(match: ResolvedCapability, envelope: CapabilityEnvelope, status: number) {
  if (envelope.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(envelope.data, null, 2) }],
      structuredContent: envelope.data,
      isError: false,
      _meta: { [MCP_CAPABILITY_META_KEY]: match.name },
    };
  }

  const { error } = envelope;
  const lines = [`${error.code}: ${error.message}`];
  if (error.issues?.length) {
    lines.push(...error.issues.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
    _meta: {
      [MCP_CAPABILITY_META_KEY]: match.name,
      [MCP_STATUS_META_KEY]: status,
      [MCP_ERROR_META_KEY]: {
        code: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupportedProtocolVersion(version: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function isCapabilityEnvelope(value: unknown): value is CapabilityEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapabilityEnvelope>;
  if (candidate.ok === true) return "data" in candidate;
  if (candidate.ok !== false || !candidate.error || typeof candidate.error !== "object") {
    return false;
  }
  if (typeof candidate.error.code !== "string" || typeof candidate.error.message !== "string") {
    return false;
  }
  return (
    candidate.error.issues === undefined ||
    (Array.isArray(candidate.error.issues) &&
      candidate.error.issues.every(
        (issue) => !!issue && typeof issue.path === "string" && typeof issue.message === "string",
      ))
  );
}

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && isSupportedProtocolVersion(requested)
    ? requested
    : MCP_LATEST_PROTOCOL_VERSION;
}

interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

function readInitializeParams(value: unknown): McpInitializeParams | null {
  if (!isObjectRecord(value)) return null;
  const { protocolVersion, capabilities, clientInfo } = value;
  if (typeof protocolVersion !== "string" || !isObjectRecord(capabilities)) return null;
  if (
    !isObjectRecord(clientInfo) ||
    typeof clientInfo.name !== "string" ||
    clientInfo.name.trim() === "" ||
    typeof clientInfo.version !== "string" ||
    clientInfo.version.trim() === ""
  ) {
    return null;
  }
  return {
    protocolVersion,
    capabilities,
    clientInfo: { name: clientInfo.name, version: clientInfo.version },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  return accept.includes("application/json") || accept.includes("*/*");
}

/** Reject browser fetches/forms; remote MCP clients send neither header. */
function isNonBrowserRequest(request: Request): boolean {
  return !request.headers.has("origin") && !request.headers.has("sec-fetch-site");
}

function jsonRpcResponse(status: number, protocolVersion: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The negotiated version, not simply the newest one we support: a client
      // that initialized at an older version should not be told the connection
      // is speaking a version it never agreed to.
      [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion,
    },
  });
}
