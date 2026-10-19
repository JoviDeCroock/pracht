/**
 * The option keys `agents.mcp` and `agents.mcp.auth` accept. Shared by the
 * runtime validator (`validateAgentsConfig`) and `pracht verify`, which reads
 * the manifest without executing it, so the two reject the same typos.
 *
 * Exhaustive by type: a new option on `McpProjectionConfig` or `McpAuthConfig`
 * does not compile until it is listed here.
 */

import type { McpAuthConfig, McpProjectionConfig } from "./server/types.ts";

const MCP_CONFIG_KEY_MAP = {
  path: true,
  serverInfo: true,
  instructions: true,
  destructive: true,
  auth: true,
  pageSize: true,
  allowedOrigins: true,
} satisfies Record<keyof McpProjectionConfig, true>;

const MCP_AUTH_CONFIG_KEY_MAP = {
  resource: true,
  authorizationServers: true,
  scopesSupported: true,
  requiredScopes: true,
  resourceDocumentation: true,
  verify: true,
} satisfies Record<keyof McpAuthConfig, true>;

export const MCP_CONFIG_KEYS: readonly string[] = Object.freeze(Object.keys(MCP_CONFIG_KEY_MAP));

export const MCP_AUTH_CONFIG_KEYS: readonly string[] = Object.freeze(
  Object.keys(MCP_AUTH_CONFIG_KEY_MAP),
);
