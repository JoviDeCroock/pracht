/** Newest first; initialization negotiates down to a version both peers know. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

export function isSupportedProtocolVersion(version: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && isSupportedProtocolVersion(requested)
    ? requested
    : MCP_LATEST_PROTOCOL_VERSION;
}

export function readInitializeParams(value: unknown): McpInitializeParams | null {
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

export function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  return accept.includes("application/json") || accept.includes("*/*");
}

/** Reject browser fetches/forms; remote MCP clients send neither header. */
export function isNonBrowserRequest(request: Request): boolean {
  return !request.headers.has("origin") && !request.headers.has("sec-fetch-site");
}

export function jsonRpcResponse(status: number, protocolVersion: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Report the negotiated version rather than the newest supported one.
      [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion,
    },
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
