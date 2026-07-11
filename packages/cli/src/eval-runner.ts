/**
 * `pracht eval` — scripted agent-task harness.
 *
 * Runs JSON scenario files against a live app's capability HTTP projection
 * and checks each step's outcome, turning the capability graph's proof
 * metrics ("can an agent actually complete this task through my tools?")
 * into repeatable CI checks. Scenario format (docs/AGENT_TRUST.md):
 *
 *   {
 *     "name": "notes flow",
 *     "task": "search, then purge with confirmation",
 *     "url": "http://localhost:3000",        // optional; --url overrides
 *     "steps": [
 *       {
 *         "capability": "notes.search",       // or "path": "/api/custom"
 *         "input": { "query": "roadmap" },
 *         "headers": { "x-pracht-confirm": "$steps[0].error.confirmationToken" },
 *         "expect": { "ok": true, "errorCode": "...", "status": 200,
 *                     "output": { "notes": [] } }  // subset match
 *       }
 *     ]
 *   }
 *
 * Reference syntax: a string value that is exactly `$steps[<index>].<path>`
 * is replaced with that value from an earlier step's result. The root object
 * per step is `{ status, ok, data, error }` — e.g.
 * `$steps[0].error.confirmationToken` or `$steps[1].data.note.id`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EvalExpectation {
  ok?: boolean;
  errorCode?: string;
  status?: number;
  /** Deep subset match against the envelope's `data`. */
  output?: unknown;
}

export interface EvalStep {
  capability: string;
  /** Custom HTTP path override (for `expose.http.path` capabilities). */
  path?: string;
  input?: unknown;
  headers?: Record<string, string>;
  expect?: EvalExpectation;
}

export interface EvalScenario {
  name: string;
  task?: string;
  url?: string;
  steps: EvalStep[];
}

export interface EvalStepResult {
  capability: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  /** Envelope error code when the step failed at the capability layer. */
  errorCode: string | null;
  /** Expectation failures; empty when the step passed. */
  failures: string[];
  /** Parsed envelope + status, used for `$steps[n]` references. */
  resultForReferences: Record<string, unknown>;
}

export interface EvalScenarioResult {
  name: string;
  file: string;
  ok: boolean;
  steps: EvalStepResult[];
  /** Scenario-level failure (bad file, no URL, network error). */
  error: string | null;
}

/** Default HTTP path for a capability name — mirrors `@pracht/core`. */
export function capabilityHttpPath(name: string): string {
  return `/api/capabilities/${name.split(".").join("/")}`;
}

// ---------------------------------------------------------------------------
// Scenario discovery and parsing
// ---------------------------------------------------------------------------

/**
 * Resolve scenario files: explicit paths as-is, otherwise every
 * `*.eval.json` under `evals/` (recursively).
 */
export function findEvalFiles(cwd: string, explicit: string[]): string[] {
  if (explicit.length > 0) {
    return explicit.map((file) => resolve(cwd, file));
  }
  const files: string[] = [];
  walkForEvalFiles(resolve(cwd, "evals"), files);
  return files.sort();
}

function walkForEvalFiles(dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walkForEvalFiles(full, files);
    } else if (entry.endsWith(".eval.json")) {
      files.push(full);
    }
  }
}

export function parseScenario(file: string): EvalScenario {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("scenario must be a JSON object");
  }
  const scenario = parsed as Partial<EvalScenario>;
  if (typeof scenario.name !== "string" || scenario.name === "") {
    throw new Error('scenario is missing a "name"');
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error('scenario needs a non-empty "steps" array');
  }
  for (const [index, step] of scenario.steps.entries()) {
    if (!step || typeof step !== "object" || typeof step.capability !== "string") {
      throw new Error(`step ${index} is missing a "capability" name`);
    }
  }
  return scenario as EvalScenario;
}

// ---------------------------------------------------------------------------
// Reference substitution
// ---------------------------------------------------------------------------

const REFERENCE_RE = /^\$steps\[(\d+)\]\.(.+)$/;

/**
 * Replace `$steps[n].<path>` string values (in inputs/headers) with values
 * from earlier step results. Unknown indices or paths throw — a scenario
 * referencing a value that does not exist is a scenario bug.
 */
export function resolveStepReferences(value: unknown, prior: EvalStepResult[]): unknown {
  if (typeof value === "string") {
    const match = REFERENCE_RE.exec(value);
    if (!match) return value;
    const index = Number(match[1]);
    if (index >= prior.length) {
      throw new Error(`reference "${value}" points at step ${index}, which has not run yet`);
    }
    let current: unknown = prior[index].resultForReferences;
    for (const segment of match[2].split(".")) {
      if (!current || typeof current !== "object") {
        throw new Error(`reference "${value}" found nothing at "${segment}"`);
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined) {
      throw new Error(`reference "${value}" resolved to undefined`);
    }
    return current;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveStepReferences(item, prior));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveStepReferences(entry, prior);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Expectation matching
// ---------------------------------------------------------------------------

/** Deep subset match: every property in `expected` must equal/subset-match `actual`. */
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => matchesSubset(actual[index], item));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    matchesSubset((actual as Record<string, unknown>)[key], value),
  );
}

export function collectExpectationFailures(
  expect: EvalExpectation | undefined,
  status: number,
  envelope: { ok?: unknown; data?: unknown; error?: { code?: unknown } },
): string[] {
  const failures: string[] = [];
  if (!expect) {
    // No expectation: the step must simply succeed.
    if (envelope.ok !== true) {
      failures.push(
        `expected ok envelope, got ${String(envelope.error?.code ?? "ok=" + String(envelope.ok))} (status ${status})`,
      );
    }
    return failures;
  }
  if (expect.ok !== undefined && envelope.ok !== expect.ok) {
    failures.push(`expected ok=${expect.ok}, got ok=${String(envelope.ok)}`);
  }
  if (expect.status !== undefined && status !== expect.status) {
    failures.push(`expected status ${expect.status}, got ${status}`);
  }
  if (expect.errorCode !== undefined && envelope.error?.code !== expect.errorCode) {
    failures.push(
      `expected error code "${expect.errorCode}", got ${JSON.stringify(envelope.error?.code ?? null)}`,
    );
  }
  if (expect.output !== undefined && !matchesSubset(envelope.data, expect.output)) {
    failures.push(`output does not match expected subset ${JSON.stringify(expect.output)}`);
  }
  return failures;
}

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
