/**
 * Remote MCP projection: stateless Streamable HTTP over the capability graph.
 * The implementation lives in `@pracht/capabilities/server/internal` — the capability
 * core — re-exported here for the framework runtime. The metadata path check
 * comes from the framework's `mcp-config.ts` wrapper so deploy-base spellings
 * keep resolving.
 */

export {
  destructiveMcpPreconditionErrors,
  handleMcpMetadataRequest,
  handleMcpRequest,
  MCP_CONFIRMATION_META_KEY,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  mcpExposedCapabilities,
  normalizeMcpRequestPath,
  type HandleMcpRequestOptions,
} from "@pracht/capabilities/server/internal";
export {
  isMcpResourceMetadataPath,
  isValidOAuthScopeToken,
  mcpResourceMetadataPath,
  mcpResourceMetadataUrl,
  OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
  resolveMcpEndpoint,
} from "./mcp-config.ts";
