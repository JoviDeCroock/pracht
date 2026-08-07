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
  CAPABILITY_TRANSPORT_HEADER,
  CONFIRMATION_HEADER,
  DEFAULT_MCP_ENDPOINT,
  findMcpToolNameCollisions,
  mcpToolName,
} from "@pracht/capabilities";
import { handleCapabilityRequest, type ResolvedCapability } from "./runtime-capabilities.ts";
import type {
  CapabilityAuditHook,
  CapabilityEnvelope,
  McpProjectionConfig,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
} from "./types.ts";

/** Newest first; `initialize` negotiates down to a version both sides know. */
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/**
 * `_meta` key carrying a prepare/commit confirmation token on a `tools/call`.
 *
 * MCP has no per-call header channel, and the token cannot travel in
 * `arguments`: it is bound to a hash of the canonicalized input, so adding it
 * there would invalidate the very binding it carries. `_meta` is the
 * protocol's designated extension slot.
 */
export const MCP_CONFIRMATION_META_KEY = "io.pracht/confirmation";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

/** Resolved endpoint path, or `null` when the app does not serve MCP. */
export function resolveMcpEndpoint(agents: PrachtAgentsConfig | undefined): string | null {
  const config = agents?.mcp;
  if (!config) return null;
  const path = config.path ?? DEFAULT_MCP_ENDPOINT;
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
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
}

/**
 * Handle one request to the MCP endpoint. Always resolves — protocol problems
 * become JSON-RPC errors, capability problems become tool errors.
 */
export async function handleMcpRequest<TContext>(
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

  // DNS-rebinding protection: a page on another origin must not be able to
  // drive the MCP endpoint. Non-browser callers send no Origin and are
  // unaffected.
  if (!isSameOriginOrNonBrowser(request, options.url)) {
    return new Response("Cross-origin request blocked", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const declaredVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
  if (declaredVersion && !isSupportedProtocolVersion(declaredVersion)) {
    return jsonRpcResponse(400, {
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
    return jsonRpcResponse(406, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Client must accept application/json." },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return jsonRpcResponse(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_PARSE_ERROR, message: "Parse error." },
    });
  }

  // JSON-RPC batching was removed from MCP; reject it rather than
  // half-supporting it.
  if (Array.isArray(payload)) {
    return jsonRpcResponse(400, {
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
    return jsonRpcResponse(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request." },
    });
  }

  // Notifications carry no id and get no body.
  if (message.id === undefined || message.id === null) {
    return new Response(null, { status: 202 });
  }
  const id = message.id as string | number;

  const collisions = findMcpToolNameCollisions(
    mcpExposedCapabilities(options.capabilities).map((entry) => entry.name),
  );
  if (collisions.length > 0) {
    // `pracht verify` reports this at build time; refuse to serve an
    // ambiguous tool list rather than picking a winner at random.
    return jsonRpcResponse(500, {
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
    case "initialize":
      return jsonRpcResponse(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(
            (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
          ),
          capabilities: { tools: { listChanged: false } },
          serverInfo: options.mcp.serverInfo ?? { name: "pracht", version: "0.0.0" },
          instructions: options.mcp.instructions,
        },
      });

    case "ping":
      return jsonRpcResponse(200, { jsonrpc: "2.0", id, result: {} });

    case "tools/list":
      return jsonRpcResponse(200, {
        jsonrpc: "2.0",
        id,
        result: { tools: mcpExposedCapabilities(options.capabilities).map(toolDescriptor) },
      });

    case "tools/call":
      return handleToolsCall(options, id, message.params);

    default:
      return jsonRpcResponse(200, {
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
      destructiveHint: false,
      idempotentHint: capability.effect === "read",
      openWorldHint: false,
    },
    _meta: { "io.pracht/capability": entry.name, "io.pracht/effect": capability.effect },
  };
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

async function handleToolsCall<TContext>(
  options: HandleMcpRequestOptions<TContext>,
  id: string | number,
  rawParams: unknown,
): Promise<Response> {
  const params = (rawParams ?? {}) as {
    name?: unknown;
    arguments?: unknown;
    _meta?: Record<string, unknown>;
  };

  if (typeof params.name !== "string") {
    return jsonRpcResponse(200, {
      jsonrpc: "2.0",
      id,
      error: { code: JSONRPC_INVALID_PARAMS, message: "tools/call requires a string `name`." },
    });
  }

  const exposed = mcpExposedCapabilities(options.capabilities);
  const match = exposed.find((entry) => mcpToolName(entry.name) === params.name);
  if (!match) {
    // An unknown tool is a protocol-level error, not a tool execution failure.
    return jsonRpcResponse(200, {
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

  const response = await handleCapabilityRequest({
    match,
    context: options.context,
    registry: options.registry,
    request: synthesizeCapabilityRequest(options, match, params.arguments, params._meta),
    url: options.url,
    exposeErrors: options.exposeErrors,
    apiMiddlewareFiles: options.apiMiddlewareFiles,
    agents: options.agents,
    agent: options.agent ?? null,
    onAudit: options.onAudit,
  });

  let envelope: CapabilityEnvelope;
  try {
    envelope = (await response.json()) as CapabilityEnvelope;
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

  return jsonRpcResponse(200, {
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
  headers.set(CAPABILITY_TRANSPORT_HEADER, "mcp");

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
      _meta: { "io.pracht/capability": match.name },
    };
  }

  const { error } = envelope;
  const lines = [`${error.code}: ${error.message}`];
  if (error.issues?.length) {
    lines.push(...error.issues.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    },
    isError: true,
    _meta: { "io.pracht/capability": match.name, "io.pracht/status": status },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupportedProtocolVersion(version: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && isSupportedProtocolVersion(requested)
    ? requested
    : MCP_LATEST_PROTOCOL_VERSION;
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  return accept.includes("application/json") || accept.includes("*/*");
}

/** The framework's CSRF stance, applied to the MCP endpoint. */
function isSameOriginOrNonBrowser(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }
  return true;
}

function jsonRpcResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [MCP_PROTOCOL_VERSION_HEADER]: MCP_LATEST_PROTOCOL_VERSION,
    },
  });
}
