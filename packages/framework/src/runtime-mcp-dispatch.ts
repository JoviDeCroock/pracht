import { CONFIRMATION_HEADER, mcpToolName } from "@pracht/capabilities";

import {
  handleCapabilityRequest,
  setActiveCapabilityHost,
  type ResolvedCapability,
} from "./runtime-capabilities.ts";
import type { HandleMcpRequestOptions } from "./runtime-mcp-options.ts";
import { JSONRPC_INVALID_PARAMS, jsonRpcResponse } from "./runtime-mcp-protocol.ts";
import {
  createMcpToolResult,
  isCapabilityEnvelope,
  mcpExposedCapabilities,
} from "./runtime-mcp-tools.ts";
import type { CapabilityEnvelope } from "./types.ts";

/** `_meta` key carrying a prepare/commit token on an MCP tools/call. */
export const MCP_CONFIRMATION_META_KEY = "io.pracht/confirmation";

/**
 * Execute one MCP tool call through the canonical capability dispatch path.
 * Request synthesis and host rebinding intentionally live in the same
 * transaction so nested `invokeCapability()` cannot lose transport identity.
 */
export async function handleMcpToolsCall<TContext>(
  options: HandleMcpRequestOptions<TContext>,
  id: string | number,
  rawParams: unknown,
  protocolVersion: string,
): Promise<Response> {
  const params = (rawParams ?? {}) as {
    name?: unknown;
    arguments?: unknown;
    _meta?: Record<string, unknown>;
  };

  if (typeof params.name !== "string") {
    return invalidParams(id, protocolVersion, "tools/call requires a string `name`.");
  }
  if (
    params.arguments !== undefined &&
    (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))
  ) {
    return invalidParams(
      id,
      protocolVersion,
      "tools/call `arguments` must be an object when provided.",
    );
  }

  const exposed = mcpExposedCapabilities(options.capabilities);
  const match = exposed.find((entry) => mcpToolName(entry.name) === params.name);
  if (!match) {
    return invalidParams(
      id,
      protocolVersion,
      `Unknown tool ${JSON.stringify(params.name)}. Known tools: ` +
        `${exposed.map((entry) => mcpToolName(entry.name)).join(", ") || "(none)"}.`,
    );
  }

  const capabilityRequest = synthesizeCapabilityRequest(
    options,
    match,
    params.arguments,
    params._meta,
  );
  setActiveCapabilityHost(
    capabilityRequest,
    options.app,
    options.registry,
    "mcp",
    options.onAudit,
    options.agent ?? null,
  );

  const response = await handleCapabilityRequest({
    match,
    context: options.context,
    registry: options.registry,
    request: capabilityRequest,
    url: new URL(capabilityRequest.url),
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
    result: createMcpToolResult(match, envelope, response.status),
  });
}

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
  const path = match.httpPath ?? `/__pracht/mcp/tools/${mcpToolName(match.name)}`;
  return new Request(new URL(path, options.url.origin).href, {
    method: "POST",
    headers,
    body: JSON.stringify(args ?? {}),
  });
}

function invalidParams(id: string | number, protocolVersion: string, message: string): Response {
  return jsonRpcResponse(200, protocolVersion, {
    jsonrpc: "2.0",
    id,
    error: { code: JSONRPC_INVALID_PARAMS, message },
  });
}
