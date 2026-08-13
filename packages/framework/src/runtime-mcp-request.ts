import {
  acceptsJson,
  isNonBrowserRequest,
  isSupportedProtocolVersion,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  jsonRpcResponse,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
} from "./runtime-mcp-protocol.ts";

export interface PreparedMcpMessage {
  id: string | number;
  method: string;
  params?: unknown;
}

export type PreparedMcpRequest =
  | { kind: "message"; message: PreparedMcpMessage; protocolVersion: string }
  | { kind: "response"; response: Response };

/** Normalize an incoming endpoint path before matching it against a request. */
export function normalizeMcpRequestPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Apply the stateless transport boundary and parse one JSON-RPC request.
 * Protocol failures are returned as ready-to-serve responses so the handler
 * can route only trusted, structurally valid messages.
 */
export async function prepareMcpRequest(request: Request): Promise<PreparedMcpRequest> {
  if (request.method.toUpperCase() !== "POST") {
    return {
      kind: "response",
      response: new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
      }),
    };
  }

  // Reject browser provenance instead of comparing Origin to a URL that an
  // adapter may have derived from an attacker-controlled Host header.
  if (!isNonBrowserRequest(request)) {
    return {
      kind: "response",
      response: new Response("Browser-originated requests are not allowed", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    };
  }

  // Adapter context may already contain authority derived from cookies, so
  // stripping them from a later synthesized capability request is too late.
  if (request.headers.has("cookie")) {
    return {
      kind: "response",
      response: new Response("Cookie-authenticated requests are not allowed", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    };
  }

  const declaredVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
  const protocolVersion =
    declaredVersion && isSupportedProtocolVersion(declaredVersion)
      ? declaredVersion
      : MCP_LATEST_PROTOCOL_VERSION;
  const respond = (status: number, payload: unknown): PreparedMcpRequest => ({
    kind: "response",
    response: jsonRpcResponse(status, protocolVersion, payload),
  });

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

  if (message.id === undefined) {
    return { kind: "response", response: new Response(null, { status: 202 }) };
  }
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    return respond(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request id." },
    });
  }

  return {
    kind: "message",
    message: { id: message.id, method: message.method, params: message.params },
    protocolVersion,
  };
}
