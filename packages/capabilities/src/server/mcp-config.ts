import { DEFAULT_MCP_ENDPOINT } from "../protocol.ts";
import type { McpAuthConfig, PrachtAgentsConfig } from "./types.ts";

export const OAUTH_PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** RFC 6749 Appendix A.4 `scope-token` (printable ASCII except `"` and `\\`). */
export function isValidOAuthScopeToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);
}

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
 * lives at the origin root by construction. Callers that serve under a deploy
 * base pass base-stripped spellings via `alternates` so a reverse proxy which
 * re-prefixes the base still resolves to the same document instead of
 * silently losing discovery.
 *
 * Both the RFC 9728 path-inserted form and the bare well-known root answer,
 * because hosts in the wild probe either. One trailing slash is tolerated, as
 * it is on the MCP endpoint itself.
 */
export function isMcpResourceMetadataPath(
  pathname: string,
  auth: McpAuthConfig,
  /**
   * Additional candidate pathnames to test, e.g. a deploy-base-stripped form
   * when a reverse proxy re-prefixes the base. `@pracht/core` passes its
   * `stripBaseLenient()` spelling here; a standalone host has no base concept
   * and passes nothing.
   */
  alternates: readonly string[] = [],
): boolean {
  for (const candidate of new Set([pathname, ...alternates])) {
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
