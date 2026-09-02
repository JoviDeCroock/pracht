/**
 * Framework integration internals for the capability server core.
 *
 * One home for the dispatch pipeline (validation → middleware → run() →
 * validation), the agent trust layer (Web Bot Auth, destructive
 * prepare/commit confirmation, durable approvals), and the remote MCP
 * projection. `@pracht/core` builds its integrated projections on these
 * exports. Applications should import the supported standalone surface from
 * `@pracht/capabilities/server` instead.
 *
 * Zero dependencies, Web-standard APIs only (`Request`, `Response`,
 * `crypto.subtle`), no Preact.
 */

// Standalone host
export {
  createCapabilityHost,
  type CapabilityHostAgentsConfig,
  type CapabilityHostFetchInit,
  type CapabilityHostInvokeOptions,
  type CapabilityHostMcpAuthConfig,
  type CapabilityHostMcpConfig,
  type CreateCapabilityHostOptions,
  type StandaloneCapabilityHost,
} from "./host.ts";

// Agent-trust config validation (shared with defineApp)
export { validateAgentsConfig, type ValidateAgentsConfigOptions } from "./agents-config.ts";

// Dispatch pipeline
export {
  addCapabilityAuditListener,
  CAPABILITY_HTTP_PREFIX,
  capabilityHttpPath,
  clearCapabilityAuditListeners,
  clearDestructiveConfirmed,
  envelopeResponse,
  handleCapabilityRequest,
  invokeCapability,
  invokeCapabilityOnHost,
  isRegisteredCapabilityHttpPath,
  matchCapabilityRoute,
  resolveAppCapabilities,
  setActiveCapabilityHost,
  setCapabilityAuditHook,
  type CapabilityHost,
  type CapabilityHostApp,
  type HandleCapabilityRequestOptions,
  type InvokeCapabilityContext,
  type ResolvedCapability,
} from "./capabilities.ts";

// Remote MCP projection
export {
  destructiveMcpPreconditionErrors,
  handleMcpMetadataRequest,
  handleMcpRequest,
  isMcpResourceMetadataPath,
  isValidOAuthScopeToken,
  MCP_CONFIRMATION_META_KEY,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  mcpExposedCapabilities,
  mcpResourceMetadataPath,
  mcpResourceMetadataUrl,
  normalizeMcpRequestPath,
  OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
  resolveMcpEndpoint,
  type HandleMcpRequestOptions,
} from "./mcp.ts";
export {
  authenticateMcpRequest,
  handleMcpResourceMetadataRequest,
  loadMcpTokenVerifier,
  mcpAuthChallengeResponse,
  mcpResourceMetadataDocument,
  readBearerToken,
  type McpAuthResult,
} from "./mcp-auth.ts";

// Destructive-capability confirmation (stateless prepare/commit)
export {
  canonicalJson,
  clearConsumedConfirmationTokens,
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  consumeConfirmationToken,
  createConfirmationToken,
  DEFAULT_CONFIRMATION_TTL_SECONDS,
  hmacSha256Base64Url,
  isWellFormedConfirmationToken,
  resolveConfirmationSecret,
  setCapabilityConfirmationSecret,
  sha256Base64Url,
  verifyConfirmationToken,
  type CapabilityConfirmationMode,
  type ConfirmationBinding,
  type ConfirmationFailure,
  type ConfirmationVerification,
} from "./confirmation.ts";

// Durable approvals
export {
  capabilityApprovalId,
  createMemoryApprovalStore,
  createSqlApprovalStore,
  hasCapabilityApprovalPrincipalResolver,
  resolveCapabilityApprovalPrincipal,
  resolveCapabilityApprovalStore,
  setCapabilityApprovalPrincipalResolver,
  setCapabilityApprovalStore,
  type MemoryApprovalStoreOptions,
  type ResolvedCapabilityApprovalPrincipal,
  type SqlApprovalStoreDialect,
  type SqlApprovalStoreExecute,
  type SqlApprovalStoreOptions,
  type SqlApprovalStoreResult,
} from "./approval.ts";

// Web Bot Auth verification
export {
  clearAgentDirectoryCache,
  ed25519JwkThumbprint,
  hasWebBotAuthIdentitySource,
  parseDirectoryJwks,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
  SIGNATURE_AGENT_DIRECTORY_PATH,
  verifyAgentSignature,
  type VerifyAgentSignatureOptions,
} from "./agent-auth.ts";

// Request-context identity binding
export {
  bindAgentContext,
  bindMcpTokenContext,
  isolateRequestContext,
  isRequestContextOverlay,
  rebindMcpTokenContext,
  snapshotAgentIdentity,
} from "./agent-context.ts";

// Shared infrastructure
export { runMiddlewareChain } from "./middleware.ts";
export { getSuffixIndex, normalizeModulePath, resolveRegistryModule } from "./registry.ts";
export { closestName, formatUnknownNameError, levenshteinDistance } from "./names.ts";
export type { UnknownNameErrorOptions } from "./names.ts";
export { resolveServerEnvSource, setServerEnv } from "./env.ts";
export { isSameOriginRequest } from "./same-origin.ts";

// Types
export type {
  AgentPolicyMode,
  CapabilityApprovalConsumeFailure,
  CapabilityApprovalConsumeResult,
  CapabilityApprovalPrincipalArgs,
  CapabilityApprovalPrincipalResolver,
  CapabilityApprovalRecord,
  CapabilityApprovalState,
  CapabilityApprovalStore,
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityConfirmationConfig,
  CapabilityModule,
  CapabilityModuleRegistry,
  CapabilityRouteDescriptor,
  McpAuthConfig,
  McpProjectionConfig,
  McpTokenPrincipal,
  McpTokenVerifier,
  McpTokenVerifierModule,
  McpTokenVerifyArgs,
  MiddlewareArgs,
  MiddlewareFn,
  MiddlewareModule,
  MiddlewareNext,
  ModuleImporter,
  PrachtAgentsConfig,
  PrachtCapability,
  PrachtContextExtensions,
  WebBotAuthConfig,
  WebBotAuthStaticKey,
} from "./types.ts";
