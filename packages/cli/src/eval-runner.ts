/** HTTP execution and server readiness for validated `pracht eval` scenarios. */

import { capabilityHttpPath, CONFIRMATION_HEADER } from "@pracht/capabilities";
import { createAgentSignatureHeaders } from "@pracht/core/agent-auth";
import {
  collectExpectationFailures,
  resolveStepReferences,
  type EvalScenario,
  type EvalScenarioResult,
  type EvalStepResult,
} from "./eval-scenario.js";

export {
  collectExpectationFailures,
  findEvalFiles,
  matchesSubset,
  parseScenario,
  resolveStepReferences,
} from "./eval-scenario.js";
export type {
  EvalExpectation,
  EvalScenario,
  EvalScenarioResult,
  EvalSignAs,
  EvalStep,
  EvalStepResult,
} from "./eval-scenario.js";
export { capabilityHttpPath };

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunScenarioOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export async function runScenario(
  scenario: EvalScenario,
  file: string,
  options: RunScenarioOptions,
): Promise<EvalScenarioResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const steps: EvalStepResult[] = [];

  for (const step of scenario.steps) {
    let input: unknown;
    let headers: Record<string, string>;
    try {
      input = resolveStepReferences(step.input === undefined ? {} : step.input, steps);
      headers = resolveStepReferences(step.headers ?? {}, steps) as Record<string, string>;
      if (step.confirm !== undefined) {
        headers[CONFIRMATION_HEADER] = String(resolveStepReferences(step.confirm, steps));
      }
    } catch (error: unknown) {
      return {
        name: scenario.name,
        file,
        ok: false,
        steps,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const path = step.path ?? capabilityHttpPath(step.capability);
    const url = new URL(path, options.baseUrl).toString();

    // The signature covers `@authority` and a `created`/`expires` window, so it
    // has to be produced per request against the concrete URL — the reason a
    // signed step cannot be expressed with static `headers`.
    if (scenario.signAs && step.sign !== false) {
      try {
        const signature = await createAgentSignatureHeaders(
          new Request(url, { method: "POST" }),
          scenario.signAs,
        );
        Object.assign(headers, signature);
      } catch (error: unknown) {
        return {
          name: scenario.name,
          file,
          ok: false,
          steps,
          error: `could not sign step "${step.capability}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    const started = performance.now();
    let status: number;
    let envelope: { ok?: unknown; data?: unknown; error?: { code?: unknown } };
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(input),
      });
      status = response.status;
      envelope = (await response.json()) as typeof envelope;
    } catch (error: unknown) {
      return {
        name: scenario.name,
        file,
        ok: false,
        steps,
        error: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const latencyMs = performance.now() - started;

    const failures = collectExpectationFailures(step.expect, status, envelope);
    steps.push({
      capability: step.capability,
      status,
      ok: envelope.ok === true,
      latencyMs,
      errorCode:
        envelope.ok === true
          ? null
          : typeof envelope.error?.code === "string"
            ? envelope.error.code
            : null,
      failures,
      resultForReferences: { status, ...envelope } as Record<string, unknown>,
    });
  }

  return {
    name: scenario.name,
    file,
    ok: steps.every((step) => step.failures.length === 0),
    steps,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// `--start` support: wait for a just-spawned app server to answer
// ---------------------------------------------------------------------------

export interface WaitForServerOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Checked between attempts — return a reason to abort early (e.g. the started process already exited). */
  earlyExit?: () => string | null;
  fetchImpl?: typeof fetch;
}

export type WaitForServerResult = { ok: true } | { ok: false; reason: string };

/**
 * Poll a base URL until the server answers. Any HTTP response counts as
 * ready — 404s included — because reachability is all the scenario runner
 * needs before it starts dispatching capability calls.
 */
export async function waitForServer(
  baseUrl: string,
  options: WaitForServerOptions = {},
): Promise<WaitForServerResult> {
  const { timeoutMs = 30_000, intervalMs = 250, earlyExit, fetchImpl = fetch } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const abortReason = earlyExit?.();
    if (abortReason) {
      return { ok: false, reason: abortReason };
    }
    try {
      await fetchImpl(baseUrl, { signal: AbortSignal.timeout(2_000) });
      return { ok: true };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return { ok: false, reason: `no response from ${baseUrl} within ${timeoutMs}ms` };
}
