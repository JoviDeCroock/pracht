import { DEFAULT_MCP_ENDPOINT } from "@pracht/capabilities";
import type { McpAuthConfig, PrachtAgentsConfig } from "./types.ts";

/** Resolved endpoint path, or `null` when the app does not serve MCP. */
export function resolveMcpEndpoint(agents: PrachtAgentsConfig | undefined): string | null {
  const config = agents?.mcp;
  if (!config) return null;
  const path = config.path ?? DEFAULT_MCP_ENDPOINT;
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

/** RFC 9728 well-known prefix for OAuth 2.0 protected-resource metadata. */
export const OAUTH_PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * The pathname RFC 9728 §3.1 assigns to a resource identifier: the well-known
 * segment is inserted *between* the host and the resource's own path, so
 * `https://app.example/mcp` publishes at
 * `/.well-known/oauth-protected-resource/mcp`.
 */
export function mcpResourceMetadataPath(auth: McpAuthConfig): string {
  let resourcePath: string;
  try {
    resourcePath = new URL(auth.resource).pathname;
  } catch {
    // `defineApp()` rejects a non-absolute resource, so this only happens for a
    // hand-built config. Fall back to the root form rather than throwing from a
    // path helper.
    resourcePath = "/";
  }
  const trimmed = resourcePath.replace(/\/+$/, "");
  return trimmed === ""
    ? OAUTH_PROTECTED_RESOURCE_WELL_KNOWN
    : `${OAUTH_PROTECTED_RESOURCE_WELL_KNOWN}${trimmed}`;
}

/** Absolute metadata URL — what the `WWW-Authenticate` challenge points at. */
export function mcpResourceMetadataUrl(auth: McpAuthConfig): string {
  return new URL(mcpResourceMetadataPath(auth), auth.resource).href;
}

/**
 * Whether a request path addresses the metadata document.
 *
 * Both the RFC 9728 path-inserted form and the bare well-known root answer,
 * because hosts in the wild probe either. One trailing slash is tolerated, as
 * it is on the MCP endpoint itself.
 */
export function isMcpResourceMetadataPath(pathname: string, auth: McpAuthConfig): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return (
    normalized === mcpResourceMetadataPath(auth) ||
    normalized === OAUTH_PROTECTED_RESOURCE_WELL_KNOWN
  );
}
