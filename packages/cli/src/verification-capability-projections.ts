import { findMcpToolNameCollisions } from "@pracht/capabilities";

import { createCheck, type Check } from "./verification-helpers.js";

/**
 * Validate constraints that emerge only after all capability contracts have
 * been projected into generated clients and protocol surfaces.
 */
export function collectCapabilityProjectionChecks(
  httpExposedNames: string[],
  mcpExposedNames: string[],
  manifestSource: string,
  checks: Check[],
): void {
  collectShadowedNameChecks(httpExposedNames, checks);
  collectMcpProjectionChecks(mcpExposedNames, manifestSource, checks);
}

/**
 * MCP tool names have to be unique, and `expose.mcp` does nothing until the
 * app configures `agents.mcp`.
 */
function collectMcpProjectionChecks(
  mcpExposedNames: string[],
  manifestSource: string,
  checks: Check[],
): void {
  if (mcpExposedNames.length === 0) return;

  for (const collision of findMcpToolNameCollisions(mcpExposedNames)) {
    checks.push(
      createCheck(
        "error",
        `Capabilities ${collision.capabilities.map((name) => JSON.stringify(name)).join(" and ")} ` +
          `both project to the MCP tool name ${JSON.stringify(collision.toolName)} ` +
          "(dots become underscores). Rename one — the runtime refuses to serve an ambiguous tool list.",
      ),
    );
  }

  if (!manifestConfiguresMcpProjection(manifestSource)) {
    checks.push(
      createCheck(
        "warning",
        `${mcpExposedNames.length} capabilit${mcpExposedNames.length === 1 ? "y sets" : "ies set"} ` +
          "expose.mcp, but the manifest does not configure agents.mcp — the exposure is recorded " +
          "in the graph and nothing serves it. Add `agents: { mcp: {} }` to defineApp() to serve " +
          "them at /mcp.",
      ),
    );
  }
}

/**
 * Conservative source scan for `agents: { … mcp: … }` in the manifest.
 *
 * Verification is static (no Vite server), so a manifest that builds its
 * `agents` config in a separate variable reads as unconfigured. That only
 * costs one spurious warning, never a failed build.
 */
function manifestConfiguresMcpProjection(manifestSource: string): boolean {
  const agentsIndex = manifestSource.search(/\bagents\s*:\s*\{/);
  if (agentsIndex === -1) return false;
  return /\bmcp\s*:/.test(manifestSource.slice(agentsIndex));
}

/**
 * The generated browser client turns dotted names into nested objects. A name
 * that is also another capability's namespace remains callable through
 * `callCapability()`, but cannot also occupy the generated client property.
 */
function collectShadowedNameChecks(names: string[], checks: Check[]): void {
  for (const name of names) {
    const shadowedBy = names.filter((other) => other.startsWith(`${name}.`));
    if (shadowedBy.length > 0) {
      checks.push(
        createCheck(
          "warning",
          `Capability ${JSON.stringify(name)} is also a namespace for ` +
            `${shadowedBy.map((other) => JSON.stringify(other)).join(", ")}, so it is not reachable ` +
            "on the generated capabilities client. Call it via callCapability() or rename it.",
        ),
      );
    }
  }
}
