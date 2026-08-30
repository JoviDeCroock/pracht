/**
 * Validation for the `agents` trust configuration, shared by
 * `defineApp({ agents })` and `createCapabilityHost({ agents })` so the
 * standalone host rejects exactly the misconfigurations the framework does.
 *
 * The security-relevant setting — the Web Bot Auth `policy` — is compared
 * with `=== "require"` at dispatch, so a typo (`"requre"`) would silently
 * fail open. Reject unknown policies, misspelled option keys, and
 * non-positive numeric trust settings so the config fails closed instead.
 * Every `agents.mcp.auth` field feeds either the published metadata document
 * or the token gate, so a malformed value is a security misconfiguration,
 * not a cosmetic one: a relative `resource` cannot be an audience, and a
 * missing `verify` would leave the endpoint advertising authentication it
 * does not perform.
 */

import { isValidOAuthScopeToken, OAUTH_PROTECTED_RESOURCE_WELL_KNOWN } from "./mcp-config.ts";
import { isValidCapabilityHttpPath } from "../protocol.ts";
import { formatUnknownNameError } from "./names.ts";
import type { PrachtAgentsConfig } from "./types.ts";

const AGENT_POLICY_MODES = ["observe", "require"];
const CONFIRMATION_MODES = ["token", "human"];
const MCP_CONFIG_KEYS = ["path", "serverInfo", "instructions", "destructive", "auth"];
const MCP_AUTH_CONFIG_KEYS = [
  "resource",
  "authorizationServers",
  "scopesSupported",
  "requiredScopes",
  "resourceDocumentation",
  "verify",
];

export interface ValidateAgentsConfigOptions {
  /**
   * Render a config path (e.g. `agents.mcp.path`) into the error-message
   * spelling of the caller's API, e.g. `defineApp({ agents.mcp.path })`.
   */
  label: (path: string) => string;
  /**
   * Map the configured MCP endpoint pathname to the public pathname the
   * `resource` identifier must address. The framework applies its deploy
   * base; a standalone host serves paths as configured.
   */
  resolvePublicEndpoint?: (endpoint: string) => string;
  /**
   * How `agents.mcp.auth.verify` is registered: a server-only module
   * reference (pracht app manifests) or the verifier function itself
   * (standalone hosts).
   */
  verifyMode: "module" | "function";
}

export function validateAgentsConfig(
  agents: PrachtAgentsConfig | undefined,
  options: ValidateAgentsConfigOptions,
): void {
  if (!agents) return;
  const { label } = options;
  const { webBotAuth, confirmation, mcp } = agents;
  if (webBotAuth) {
    if (webBotAuth.policy !== undefined && !AGENT_POLICY_MODES.includes(webBotAuth.policy)) {
      throw new Error(
        `${label("agents.webBotAuth.policy")} must be one of ${AGENT_POLICY_MODES.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(webBotAuth.policy)}.`,
      );
    }
    for (const key of [
      "clockSkewSeconds",
      "maxLifetimeSeconds",
      "directoryCacheTtlSeconds",
    ] as const) {
      assertPositiveNumber(webBotAuth[key], `agents.webBotAuth.${key}`, options);
    }
  }
  if (confirmation) {
    if (confirmation.mode !== undefined && !CONFIRMATION_MODES.includes(confirmation.mode)) {
      throw new Error(
        `${label("agents.confirmation.mode")} must be one of ${CONFIRMATION_MODES.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(confirmation.mode)}.`,
      );
    }
    assertPositiveNumber(confirmation.ttlSeconds, "agents.confirmation.ttlSeconds", options);
  }
  if (mcp) {
    assertKnownSecurityKeys(mcp, MCP_CONFIG_KEYS, label("agents.mcp"));
    if (mcp.path !== undefined && !isValidCapabilityHttpPath(mcp.path)) {
      throw new Error(
        `${label("agents.mcp.path")} must be an exact same-origin pathname starting with "/".`,
      );
    }
  }
  // Compared with `=== true` at serve time, so a truthy typo would otherwise
  // read as "off" while looking enabled in the manifest. Reject anything that
  // is not a boolean instead.
  if (mcp?.destructive !== undefined && typeof mcp.destructive !== "boolean") {
    throw new Error(
      `${label("agents.mcp.destructive")} must be a boolean, got ${JSON.stringify(mcp.destructive)}.`,
    );
  }
  if (mcp?.auth) validateMcpAuthConfig(mcp, options);
}

function validateMcpAuthConfig(
  mcp: NonNullable<PrachtAgentsConfig["mcp"]>,
  options: ValidateAgentsConfigOptions,
): void {
  const auth = mcp.auth!;
  const { label } = options;
  assertKnownSecurityKeys(auth, MCP_AUTH_CONFIG_KEYS, label("agents.mcp.auth"));
  const resource = assertAbsoluteUrl(auth.resource, label("agents.mcp.auth.resource"));
  if (resource.search || resource.hash) {
    throw new Error(
      `${label("agents.mcp.auth.resource")} must not carry a query string or fragment, got ${JSON.stringify(auth.resource)}.`,
    );
  }
  assertCanonicalOAuthUrl(auth.resource, resource, label("agents.mcp.auth.resource"), true);

  // RFC 8707 makes the resource identifier the token audience, and hosts derive
  // the metadata URL from it. Pointing it at a path the app does not serve
  // yields tokens no request can ever present.
  const endpoint = (mcp.path ?? "/mcp").replace(/\/$/, "") || "/";
  if (endpoint === OAUTH_PROTECTED_RESOURCE_WELL_KNOWN) {
    throw new Error(
      `${label("agents.mcp.auth.path")} must not use the reserved OAuth protected-resource metadata path ${JSON.stringify(OAUTH_PROTECTED_RESOURCE_WELL_KNOWN)}.`,
    );
  }
  const resourcePath = resource.pathname || "/";
  if (resourcePath.length > 1 && resourcePath.endsWith("/")) {
    throw new Error(
      `${label("agents.mcp.auth.resource")} must not carry a trailing slash. OAuth resource identifiers are ` +
        `matched exactly; use the endpoint's canonical path ${JSON.stringify(endpoint)}.`,
    );
  }
  const publicEndpoint =
    (options.resolvePublicEndpoint?.(endpoint) ?? endpoint).replace(/\/$/, "") || "/";
  if (resourcePath !== publicEndpoint) {
    throw new Error(
      `${label("agents.mcp.auth.resource")} path ${JSON.stringify(resource.pathname)} does not address the MCP ` +
        `endpoint ${JSON.stringify(publicEndpoint)}. The resource identifier is the token audience; ` +
        "it must be the endpoint's exact absolute public URL, including the configured deploy base.",
    );
  }

  if (!Array.isArray(auth.authorizationServers) || auth.authorizationServers.length === 0) {
    throw new Error(
      `${label("agents.mcp.auth.authorizationServers")} must list at least one absolute authorization server issuer URL.`,
    );
  }
  for (const issuer of auth.authorizationServers) {
    const issuerUrl = assertAbsoluteUrl(issuer, label("agents.mcp.auth.authorizationServers"));
    if (issuerUrl.search || issuerUrl.hash) {
      throw new Error(
        `${label("agents.mcp.auth.authorizationServers")} issuer URLs must not carry a query string or fragment, got ${JSON.stringify(issuer)}.`,
      );
    }
    assertCanonicalOAuthUrl(issuer, issuerUrl, label("agents.mcp.auth.authorizationServers"), true);
  }
  if (auth.resourceDocumentation !== undefined) {
    assertAbsoluteUrl(auth.resourceDocumentation, label("agents.mcp.auth.resourceDocumentation"));
  }

  assertScopeList(auth.scopesSupported, label("agents.mcp.auth.scopesSupported"), options);
  assertScopeList(auth.requiredScopes, label("agents.mcp.auth.requiredScopes"), options);

  if (options.verifyMode === "function") {
    if (typeof auth.verify !== "function") {
      throw new Error(
        `${label("agents.mcp.auth.verify")} must be the verifier function itself — ` +
          "a standalone host registers no module references.",
      );
    }
  } else if (typeof auth.verify !== "string" || auth.verify === "") {
    throw new Error(
      `${label("agents.mcp.auth.verify")} must reference a server-only module whose default export verifies a ` +
        'bearer token, e.g. `verify: () => import("./server/mcp-token.ts")`.',
    );
  }
}

/** Security configuration must reject misspelled fields in every server build. */
function assertKnownSecurityKeys(config: object, allowed: string[], context: string): void {
  for (const key of Object.keys(config)) {
    if (allowed.includes(key)) continue;
    throw new Error(
      formatUnknownNameError({
        kind: "option",
        kindPlural: "options",
        name: key,
        registered: allowed,
        context,
      }),
    );
  }
}

function assertAbsoluteUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be an absolute URL string, got ${JSON.stringify(value)}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL, got ${JSON.stringify(value)}.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} must use https (http is allowed for loopback development only).`);
  }
  return url;
}

/**
 * OAuth identifiers are compared as exact strings. Reject spellings whose URL
 * serialization changes their host, port, or path instead of publishing one
 * value while requests and challenges use another. A root issuer without the
 * URL serializer's implicit trailing slash remains valid (and conventional).
 */
function assertCanonicalOAuthUrl(
  value: string,
  url: URL,
  label: string,
  allowRootWithoutSlash: boolean,
): void {
  const rootWithoutSlash =
    allowRootWithoutSlash &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === `${value}/`;
  if (url.href === value || rootWithoutSlash) return;
  throw new Error(
    `${label} must use its canonical URL spelling ${JSON.stringify(url.href)} because OAuth identifiers are matched exactly; got ${JSON.stringify(value)}.`,
  );
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return !!ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255);
}

function assertScopeList(
  value: readonly string[] | undefined,
  label: string,
  _options: ValidateAgentsConfigOptions,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((scope) => !isValidOAuthScopeToken(scope))) {
    throw new Error(
      `${label} must be an array of OAuth scope tokens using printable ASCII except quotes and backslashes.`,
    );
  }
}

function assertPositiveNumber(
  value: number | undefined,
  path: string,
  options: ValidateAgentsConfigOptions,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${options.label(path)} must be a positive number, got ${JSON.stringify(value)}.`,
    );
  }
}
