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

export { resolveMcpEndpoint } from "./mcp-config.ts";
import { handleMcpToolsCall } from "./runtime-mcp-dispatch.ts";
import type { HandleMcpRequestOptions } from "./runtime-mcp-options.ts";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  jsonRpcResponse,
  negotiateProtocolVersion,
  readInitializeParams,
} from "./runtime-mcp-protocol.ts";
import { prepareMcpRequest } from "./runtime-mcp-request.ts";
import { validateMcpToolRegistry } from "./runtime-mcp-tool-registry.ts";
import { createMcpToolDescriptor } from "./runtime-mcp-tools.ts";

/** `_meta` key carrying a prepare/commit confirmation token on a `tools/call`. */
export { MCP_CONFIRMATION_META_KEY } from "./runtime-mcp-dispatch.ts";
export type { HandleMcpRequestOptions } from "./runtime-mcp-options.ts";

export {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
} from "./runtime-mcp-protocol.ts";

export { normalizeMcpRequestPath } from "./runtime-mcp-request.ts";

/** Capabilities the MCP projection serves, in graph order. */
export { mcpExposedCapabilities } from "./runtime-mcp-tools.ts";

/**
 * Handle one request to the MCP endpoint. Always resolves — protocol problems
 * become JSON-RPC errors, capability problems become tool errors.
 */ export async function handleMcpRequest<TContext>(
  options: HandleMcpRequestOptions<TContext>,
): Promise<Response> {
  const { request } = options;
  const prepared = await prepareMcpRequest(request);
  if (prepared.kind === "response") return prepared.response;

  const { message } = prepared;
  let activeVersion = prepared.protocolVersion;
  const respond = (status: number, payload: unknown): Response =>
    jsonRpcResponse(status, activeVersion, payload);
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

  const toolRegistry = validateMcpToolRegistry(options.capabilities);
  if (!toolRegistry.ok) {
    return respond(200, {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INTERNAL_ERROR,
        message: toolRegistry.message,
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
          tools: toolRegistry.capabilities.map(createMcpToolDescriptor),
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
