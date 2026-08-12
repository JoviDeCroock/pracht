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
  findMcpToolNameCollisions,
  isValidMcpToolName,
  MCP_TOOL_NAME_ERROR,
  mcpToolName,
} from "@pracht/capabilities";
export { resolveMcpEndpoint } from "./mcp-config.ts";
import { handleMcpToolsCall } from "./runtime-mcp-dispatch.ts";
import type { HandleMcpRequestOptions } from "./runtime-mcp-options.ts";
import {
  acceptsJson,
  isNonBrowserRequest,
  isSupportedProtocolVersion,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  jsonRpcResponse,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  readInitializeParams,
} from "./runtime-mcp-protocol.ts";
import { createMcpToolDescriptor, mcpExposedCapabilities } from "./runtime-mcp-tools.ts";

/** `_meta` key carrying a prepare/commit confirmation token on a `tools/call`. */
export { MCP_CONFIRMATION_META_KEY } from "./runtime-mcp-dispatch.ts";
export type { HandleMcpRequestOptions } from "./runtime-mcp-options.ts";

export {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
} from "./runtime-mcp-protocol.ts";

/** Normalize an incoming MCP request path without retaining protocol helpers in unrelated apps. */
export function normalizeMcpRequestPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Capabilities the MCP projection serves, in graph order. */
export { mcpExposedCapabilities } from "./runtime-mcp-tools.ts";

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
        result: {
          tools: mcpExposedCapabilities(options.capabilities).map(createMcpToolDescriptor),
        },
      });

    case "tools/call":
      return handleMcpToolsCall(options, id, message.params, activeVersion);

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
