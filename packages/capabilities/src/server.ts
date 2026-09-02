/**
 * Supported server-side capability APIs.
 *
 * Framework integration machinery lives behind `@pracht/capabilities/server/internal`;
 * it is deliberately excluded here so the public entry remains a small, stable contract.
 */
export {
  createCapabilityHost,
  type CapabilityHostAgentsConfig,
  type CapabilityHostFetchInit,
  type CapabilityHostInvokeOptions,
  type CapabilityHostMcpAuthConfig,
  type CapabilityHostMcpConfig,
  type CreateCapabilityHostOptions,
  type StandaloneCapabilityHost,
} from "./server/host.ts";
export {
  addCapabilityAuditListener,
  clearCapabilityAuditListeners,
  invokeCapability,
  setCapabilityAuditHook,
  type InvokeCapabilityContext,
  type ResolvedCapability,
} from "./server/capabilities.ts";
export { destructiveMcpPreconditionErrors } from "./server/mcp.ts";
export {
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  setCapabilityConfirmationSecret,
} from "./server/confirmation.ts";
export {
  createMemoryApprovalStore,
  createSqlApprovalStore,
  setCapabilityApprovalPrincipalResolver,
  setCapabilityApprovalStore,
  type MemoryApprovalStoreOptions,
  type SqlApprovalStoreDialect,
  type SqlApprovalStoreExecute,
  type SqlApprovalStoreOptions,
  type SqlApprovalStoreResult,
} from "./server/approval.ts";
export { verifyAgentSignature, type VerifyAgentSignatureOptions } from "./server/agent-auth.ts";
export type {
  CapabilityApprovalPrincipalArgs,
  CapabilityApprovalPrincipalResolver,
  CapabilityApprovalRecord,
  CapabilityApprovalState,
  CapabilityApprovalStore,
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityConfirmationConfig,
  McpTokenPrincipal,
  McpTokenVerifier,
  McpTokenVerifyArgs,
  MiddlewareArgs,
  MiddlewareFn,
  MiddlewareNext,
  PrachtAgentsConfig,
  PrachtContextExtensions,
  WebBotAuthConfig,
  WebBotAuthStaticKey,
} from "./server/types.ts";
