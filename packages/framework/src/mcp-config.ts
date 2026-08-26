import { DEFAULT_MCP_ENDPOINT } from "@pracht/capabilities";
import { stripBaseLenient } from "./base.ts";
import { OAUTH_PROTECTED_RESOURCE_WELL_KNOWN } from "./runtime-constants.ts";
import type { McpAuthConfig, PrachtAgentsConfig } from "./types.ts";

export { OAUTH_PROTECTED_RESOURCE_WELL_KNOWN };

/** Resolved endpoint path, or `null` when the app does not serve MCP. */
export function resolveMcpEndpoint(agents: PrachtAgentsConfig | undefined): string | null {
  const config = agents?.mcp;
  if (!config) return null;
  const path = config.path ?? DEFAULT_MCP_ENDPOINT;
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

/**
 * The pathname RFC 9728 §3.1 assigns to a resource identifier: the well-known
 * segment is inserted *between* the host and the resource's own path, so
 * `https://app.example/mcp` publishes at
 * `/.well-known/oauth-protected-resource/mcp`.
 *
 * Note what that means under a deploy base. An app mounted at `/app/` whose
 * resource is `https://app.example/app/mcp` publishes at
 * `https://app.example/.well-known/oauth-protected-resource/app/mcp` — origin
 * root, base *inside* the suffix, not in front of it. The base is part of the
 * resource path, never a prefix of the well-known segment.
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
 * Whether a **URL** pathname addresses the metadata document.
 *
 * Takes the raw `url.pathname`, not a base-stripped route path: the document
 * lives at the origin root, so `stripBase()` answers `null` for it and the
 * request would 404 before ever reaching the MCP surface. `stripBaseLenient()`
 * is applied anyway so that a reverse proxy which re-prefixes the base (the
 * `basePathStripped` path) still resolves to the same document instead of
 * silently losing discovery.
 *
 * Both the RFC 9728 path-inserted form and the bare well-known root answer,
 * because hosts in the wild probe either. One trailing slash is tolerated, as
 * it is on the MCP endpoint itself.
 */
export function isMcpResourceMetadataPath(pathname: string, auth: McpAuthConfig): boolean {
  for (const candidate of new Set([pathname, stripBaseLenient(pathname)])) {
    const normalized =
      candidate.length > 1 && candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    if (
      normalized === mcpResourceMetadataPath(auth) ||
      normalized === OAUTH_PROTECTED_RESOURCE_WELL_KNOWN
    ) {
      return true;
    }
  }
  return false;
}
