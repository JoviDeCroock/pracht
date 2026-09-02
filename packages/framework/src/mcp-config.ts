/**
 * MCP endpoint/metadata path helpers. The implementations live in
 * `@pracht/capabilities/server/internal`; this module re-exports them and layers the
 * framework's deploy-base handling onto the metadata path check.
 */

import {
  isMcpResourceMetadataPath as isMcpResourceMetadataPathStandalone,
  OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
} from "@pracht/capabilities/server/internal";
import { stripBaseLenient } from "./base.ts";
import type { McpAuthConfig } from "./types.ts";

export {
  isValidOAuthScopeToken,
  mcpResourceMetadataPath,
  mcpResourceMetadataUrl,
  resolveMcpEndpoint,
} from "@pracht/capabilities/server/internal";
export { OAUTH_PROTECTED_RESOURCE_WELL_KNOWN };

/**
 * Whether a **URL** pathname addresses the metadata document.
 *
 * Takes the raw `url.pathname`, not a base-stripped route path: the document
 * lives at the origin root, so `stripBase()` answers `null` for it and the
 * request would 404 before ever reaching the MCP surface. `stripBaseLenient()`
 * is applied anyway so that a reverse proxy which re-prefixes the base (the
 * `basePathStripped` path) still resolves to the same document instead of
 * silently losing discovery.
 */
export function isMcpResourceMetadataPath(pathname: string, auth: McpAuthConfig): boolean {
  return isMcpResourceMetadataPathStandalone(pathname, auth, [stripBaseLenient(pathname)]);
}
