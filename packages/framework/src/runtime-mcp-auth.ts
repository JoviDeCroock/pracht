/**
 * OAuth 2.0 resource-server surface for the remote MCP endpoint. The
 * implementation lives in `@pracht/capabilities/server/internal` — the capability
 * core — re-exported here for the framework runtime.
 */

export {
  authenticateMcpRequest,
  bindMcpTokenContext,
  handleMcpResourceMetadataRequest,
  loadMcpTokenVerifier,
  mcpAuthChallengeResponse,
  mcpResourceMetadataDocument,
  readBearerToken,
  type McpAuthResult,
} from "@pracht/capabilities/server/internal";
