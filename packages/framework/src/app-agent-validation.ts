import { isValidCapabilityHttpPath } from "@pracht/capabilities";

import type { PrachtAgentsConfig } from "./types.ts";

const AGENT_POLICY_MODES = ["observe", "require"];
const CONFIRMATION_MODES = ["token", "human"];

/**
 * Validate security-sensitive agent manifest settings fail-closed. This must
 * remain outside development-only manifest validation: dispatch compares exact
 * policy values, so accepting a typo in production would weaken enforcement.
 */
export function validateAgentsConfig(agents: PrachtAgentsConfig | undefined): void {
  if (!agents) return;
  const { webBotAuth, confirmation, mcp } = agents;

  if (webBotAuth) {
    if (webBotAuth.policy !== undefined && !AGENT_POLICY_MODES.includes(webBotAuth.policy)) {
      throw new Error(
        `defineApp({ agents.webBotAuth.policy }) must be one of ${AGENT_POLICY_MODES.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(webBotAuth.policy)}.`,
      );
    }
    for (const key of [
      "clockSkewSeconds",
      "maxLifetimeSeconds",
      "directoryCacheTtlSeconds",
    ] as const) {
      assertPositiveNumber(webBotAuth[key], `agents.webBotAuth.${key}`);
    }
  }

  if (confirmation) {
    if (confirmation.mode !== undefined && !CONFIRMATION_MODES.includes(confirmation.mode)) {
      throw new Error(
        `defineApp({ agents.confirmation.mode }) must be one of ${CONFIRMATION_MODES.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(confirmation.mode)}.`,
      );
    }
    assertPositiveNumber(confirmation.ttlSeconds, "agents.confirmation.ttlSeconds");
  }

  if (mcp?.path !== undefined && !isValidCapabilityHttpPath(mcp.path)) {
    throw new Error(
      'defineApp({ agents.mcp.path }) must be an exact same-origin pathname starting with "/".',
    );
  }
}

function assertPositiveNumber(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `defineApp({ ${label} }) must be a positive number, got ${JSON.stringify(value)}.`,
    );
  }
}
