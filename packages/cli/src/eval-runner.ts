/**
 * `pracht eval` — scripted agent-task harness.
 *
 * Runs JSON scenario files against a live app's agent surface and checks each
 * step's outcome, turning the capability graph's proof metrics ("can an agent
 * actually complete this task through my tools?") into repeatable CI checks.
 * Two transports, one scenario format: the capability HTTP projection
 * (`/api/capabilities/*`, the default) and the remote MCP projection (JSON-RPC
 * `tools/call` against `/mcp`), so an app that advertises `expose.mcp` can
 * prove an MCP host actually reaches the tool. Scenario format
 * (docs/AGENT_TRUST.md):
 *
 *   {
 *     "name": "notes flow",
 *     "task": "search, then purge with confirmation",
 *     "url": "http://localhost:3000",        // optional; --url overrides
 *     "transport": "http",                   // or "mcp"; default "http"
 *     "mcpPath": "/mcp",                     // MCP endpoint, when it is not the default
 *     "steps": [
 *       {
 *         "capability": "notes.search",       // or "path": "/api/custom"
 *         "input": { "query": "roadmap" },
 *         "confirm": "$steps[0].error.confirmationToken",  // HTTP: confirmation header
 *         "expect": { "ok": true, "errorCode": "...", "status": 200,
 *                     "output": { "notes": [] } }  // subset match
 *       }
 *     ],
 *     "signAs": {                              // optional Web Bot Auth identity
 *       "agent": "https://my-agent.example",
 *       "privateKeyJwk": { "kty": "OKP", "crv": "Ed25519", "d": "...", "x": "..." }
 *     }
 *   }
 *
 * `signAs` signs every step with RFC 9421 HTTP Message Signatures, which is
 * what a capability declaring `agentPolicy: "require"` demands. Per-step
 * `"sign": false` opts a step out, so one scenario can prove both the signed
 * and unsigned halves of an agent-trust policy. Over MCP the same identity
 * signs the JSON-RPC POSTs, so an agent-identity policy is exercisable on
 * either transport.
 *
 * Destructive prepare/commit works over MCP when the app opts in, exposes the
 * capability, and registers an approval store. `confirm` is carried in the
 * `tools/call` `_meta["io.pracht/confirmation"]` field — the slot the
 * projection reads. Step `headers` are still limited to `authorization` over
 * MCP, the only header the projection forwards.
 *
 * Reference syntax: a string value that is exactly `$steps[<index>].<path>`
 * is replaced with that value from an earlier step's result. The root object
 * per step is `{ status, ok, data, error }` — e.g.
 * `$steps[0].error.confirmationToken` or `$steps[1].data.note.id`. MCP steps
 * fill the same shape: `data` is the tool result's `structuredContent`,
 * `error` is its `io.pracht/error` metadata, and `status` is the capability
 * dispatch status the projection reports in `io.pracht/status` — *not* the
 * JSON-RPC POST status, which is 200 for every answered `tools/call` and would
 * make `"status": 200` pass on a failed call. Expectations are therefore
 * written once and mean the same thing on both transports; the raw transport
 * status stays available as `$steps[n].transportStatus`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  capabilityHttpPath,
  CONFIRMATION_HEADER,
  DEFAULT_MCP_ENDPOINT,
  MCP_CONFIRMATION_META_KEY,
  MCP_ERROR_META_KEY,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSIONS,
  MCP_STATUS_META_KEY,
  mcpToolName,
} from "@pracht/capabilities";
import { createAgentSignatureHeaders, type AgentSigningJwk } from "@pracht/core/agent-auth";

/**
 * Which projection a scenario drives.
 *
 * `"http"` posts to the capability HTTP endpoints. `"mcp"` performs a real
 * `initialize` handshake against the app's MCP endpoint and issues every step
 * as a `tools/call` — the same round trip an MCP host makes.
 */
export type EvalTransport = "http" | "mcp";

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
  /**
   * Extra request headers. Over MCP only `authorization` is accepted: the
   * projection synthesizes the capability request and copies nothing else, so
   * any other header would silently never reach the capability.
   */
  headers?: Record<string, string>;
  /**
   * Confirmation token for committing a destructive capability — usually a
   * `$steps[n].error.confirmationToken` reference. Sets the confirmation
   * header without spelling out the header name.
   *
   * Over MCP the token travels in the
   * `tools/call` `_meta["io.pracht/confirmation"]` field.
   */
  confirm?: string;
  /**
   * Opt this step out of the scenario's `signAs` identity — for asserting that
   * an `agentPolicy: "require"` capability rejects unsigned callers.
   */
  sign?: boolean;
  expect?: EvalExpectation;
}

/**
 * Web Bot Auth identity used to sign every step of a scenario.
 *
 * The signature covers `@authority`, so it is computed per request against the
 * URL actually being called — which is why this cannot be expressed as static
 * `headers` and needed first-class support.
 */
export interface EvalSignAs {
  agent: string;
  privateKeyJwk: AgentSigningJwk;
  keyId?: string;
  lifetimeSeconds?: number;
}

export interface EvalScenario {
  name: string;
  task?: string;
  url?: string;
  /** Projection to drive. Default `"http"`. */
  transport?: EvalTransport;
  /** MCP endpoint path when the app serves MCP somewhere other than `/mcp`. */
  mcpPath?: string;
  /** Sign every step (unless the step sets `"sign": false`) as this agent. */
  signAs?: EvalSignAs;
  steps: EvalStep[];
}

export interface EvalStepResult {
  capability: string;
  /** Projection the step was dispatched through. */
  transport: EvalTransport;
  /**
   * Capability dispatch status. Over HTTP that is the response status; over MCP
   * it is the projection's `io.pracht/status` metadata, so the same expectation
   * holds on both transports.
   */
  status: number;
  /** Status of the request actually made — differs from `status` only over MCP. */
  transportStatus: number;
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
  /**
   * Projection the scenario drives. Carried here rather than read off the first
   * step so a scenario that fails before any step ran still reports it.
   */
  transport: EvalTransport;
  ok: boolean;
  steps: EvalStepResult[];
  /** Scenario-level failure (bad file, no URL, network error). */
  error: string | null;
}

export { capabilityHttpPath };

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
  if (
    scenario.transport !== undefined &&
    scenario.transport !== "http" &&
    scenario.transport !== "mcp"
  ) {
    throw new Error(
      `"transport" must be "http" or "mcp", got ${JSON.stringify(scenario.transport)}`,
    );
  }
  if (scenario.mcpPath !== undefined) {
    if (typeof scenario.mcpPath !== "string" || !scenario.mcpPath.startsWith("/")) {
      throw new Error('"mcpPath" must be an absolute path such as "/mcp"');
    }
    if (scenario.transport !== "mcp") {
      throw new Error('"mcpPath" only applies to a scenario with "transport": "mcp"');
    }
  }
  // `path` addresses an HTTP endpoint; over MCP a step is addressed by tool
  // name. Rejecting the combination here beats posting a scenario's custom
  // path at an MCP endpoint and reporting whatever 404 comes back.
  if (scenario.transport === "mcp") {
    const withPath = scenario.steps.findIndex((step) => step.path !== undefined);
    if (withPath >= 0) {
      throw new Error(
        `step ${withPath} sets "path", which only applies to the HTTP transport — ` +
          "an MCP step is addressed by its projected tool name",
      );
    }
  }
  // Validated here rather than at first use: a malformed identity would
  // otherwise surface as an unsigned request being rejected by the server,
  // which reads like an application failure instead of a scenario bug.
  if (scenario.signAs !== undefined) {
    const signAs = scenario.signAs as Partial<EvalSignAs>;
    if (!signAs || typeof signAs !== "object") {
      throw new Error('"signAs" must be an object with "agent" and "privateKeyJwk"');
    }
    if (typeof signAs.agent !== "string" || signAs.agent === "") {
      throw new Error('"signAs.agent" must be the agent\'s identity URL');
    }
    const jwk = signAs.privateKeyJwk as Partial<AgentSigningJwk> | undefined;
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      throw new Error('"signAs.privateKeyJwk" must be an Ed25519 OKP JWK');
    }
    if (typeof jwk.d !== "string" || typeof jwk.x !== "string") {
      throw new Error('"signAs.privateKeyJwk" needs both "d" (private) and "x" (public)');
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

/**
 * `status` is the *capability dispatch* status on either transport — see
 * `dispatchFromToolResult()` for how the MCP side derives it. Passing the
 * JSON-RPC POST status here instead would make `"status": 200` pass on a failed
 * `tools/call`.
 */
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

/** Capability envelope shape both transports normalize to. */
interface EvalEnvelope {
  ok?: unknown;
  data?: unknown;
  error?: { code?: unknown } & Record<string, unknown>;
}

interface DispatchOutcome {
  /** Capability dispatch status — what `expect.status` asserts on either transport. */
  status: number;
  /** Status of the request actually made (identical to `status` over HTTP). */
  transportStatus: number;
  envelope: EvalEnvelope;
}

/** One dispatched step, or a scenario-fatal explanation of why it could not be. */
type DispatchResult = DispatchOutcome | { error: string };

export async function runScenario(
  scenario: EvalScenario,
  file: string,
  options: RunScenarioOptions,
): Promise<EvalScenarioResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const transport: EvalTransport = scenario.transport ?? "http";
  const steps: EvalStepResult[] = [];
  const abort = (error: string): EvalScenarioResult => ({
    name: scenario.name,
    file,
    transport,
    ok: false,
    steps,
    error,
  });

  // One handshake per scenario, not per step: `initialize` is what an MCP host
  // does once per connection, and doing it here means a misconfigured endpoint
  // reports as "this app does not serve MCP" instead of as N failing tools.
  let session: McpSession | undefined;
  if (transport === "mcp") {
    const endpoint = new URL(scenario.mcpPath ?? DEFAULT_MCP_ENDPOINT, options.baseUrl).toString();
    const opened = await openMcpSession(endpoint, scenario, fetchImpl);
    if ("error" in opened) return abort(opened.error);
    session = opened.session;
  }

  for (const [index, step] of scenario.steps.entries()) {
    let input: unknown;
    let headers: Record<string, string>;
    let confirmation: string | undefined;
    try {
      input = resolveStepReferences(step.input === undefined ? {} : step.input, steps);
      headers = resolveStepReferences(step.headers ?? {}, steps) as Record<string, string>;
      if (step.confirm !== undefined) {
        confirmation = String(resolveStepReferences(step.confirm, steps));
      }
    } catch (error: unknown) {
      return abort(error instanceof Error ? error.message : String(error));
    }

    const sign = scenario.signAs !== undefined && step.sign !== false;
    const started = performance.now();
    const dispatched = session
      ? await callMcpTool({ session, step, index, input, headers, confirmation, sign })
      : await callHttpCapability({
          baseUrl: options.baseUrl,
          fetchImpl,
          signAs: sign ? scenario.signAs : undefined,
          step,
          input,
          headers:
            confirmation === undefined
              ? headers
              : { ...headers, [CONFIRMATION_HEADER]: confirmation },
        });
    if ("error" in dispatched) return abort(dispatched.error);
    const latencyMs = performance.now() - started;

    const { status, transportStatus, envelope } = dispatched;
    const failures = collectExpectationFailures(step.expect, status, envelope);
    steps.push({
      capability: step.capability,
      transport,
      status,
      transportStatus,
      ok: envelope.ok === true,
      latencyMs,
      errorCode:
        envelope.ok === true
          ? null
          : typeof envelope.error?.code === "string"
            ? envelope.error.code
            : null,
      failures,
      resultForReferences: { status, transportStatus, ...envelope } as Record<string, unknown>,
    });
  }

  return {
    name: scenario.name,
    file,
    transport,
    ok: steps.every((step) => step.failures.length === 0),
    steps,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP projection transport
// ---------------------------------------------------------------------------

async function callHttpCapability(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  signAs: EvalSignAs | undefined;
  step: EvalStep;
  input: unknown;
  headers: Record<string, string>;
}): Promise<DispatchResult> {
  const { baseUrl, fetchImpl, signAs, step, input } = args;
  const headers = { ...args.headers };
  const path = step.path ?? capabilityHttpPath(step.capability);
  const url = new URL(path, baseUrl).toString();

  // The signature covers `@authority` and a `created`/`expires` window, so it
  // has to be produced per request against the concrete URL — the reason a
  // signed step cannot be expressed with static `headers`.
  if (signAs) {
    const signature = await signRequestHeaders(url, signAs);
    if ("error" in signature)
      return { error: `could not sign step "${step.capability}": ${signature.error}` };
    Object.assign(headers, signature.headers);
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      transportStatus: response.status,
      envelope: (await response.json()) as EvalEnvelope,
    };
  } catch (error: unknown) {
    return {
      error: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function signRequestHeaders(
  url: string,
  signAs: EvalSignAs,
): Promise<{ headers: Record<string, string> } | { error: string }> {
  try {
    return {
      headers: {
        ...(await createAgentSignatureHeaders(new Request(url, { method: "POST" }), signAs)),
      },
    };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Remote MCP transport
// ---------------------------------------------------------------------------

/** Client identity sent in `initialize`; hosts log it, and so do app audit events. */
const MCP_CLIENT_INFO = { name: "pracht-eval", version: "1.0.0" } as const;

/**
 * The only step header the MCP projection forwards to the capability. It
 * synthesizes the inner request itself and copies nothing else, so any other
 * header would be accepted by the runner and then silently never arrive.
 */
const MCP_FORWARDED_HEADER = "authorization";

/**
 * Headers the MCP endpoint refuses outright (403), because remote MCP has no
 * browser use case and must never be authenticated by an ambient cookie.
 * Called out separately so the failure explains the 403 rather than the drop.
 */
const MCP_REFUSED_HEADERS = ["cookie", "origin", "sec-fetch-site"];

interface McpSession {
  endpoint: string;
  /** Version agreed in `initialize`, declared on every later request. */
  protocolVersion: string;
  nextId: number;
  signAs?: EvalSignAs;
  fetchImpl: typeof fetch;
}

interface McpHttpResponse {
  status: number;
  body: unknown;
  bodyText: string;
}

async function openMcpSession(
  endpoint: string,
  scenario: EvalScenario,
  fetchImpl: typeof fetch,
): Promise<{ session: McpSession } | { error: string }> {
  const session: McpSession = {
    endpoint,
    protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
    nextId: 1,
    signAs: scenario.signAs,
    fetchImpl,
  };

  const response = await mcpRequest(session, {
    method: "initialize",
    params: {
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    },
    sign: scenario.signAs !== undefined,
    signLabel: "the MCP initialize request",
    // Nothing is negotiated yet, so claiming a version would be a guess.
    declareProtocolVersion: false,
  });
  if ("error" in response) return { error: response.error };
  if (response.status !== 200) {
    return { error: describeMcpEndpointStatus(endpoint, response) };
  }

  const body = asRecord(response.body);
  if (!body) {
    return {
      error: `MCP initialize at ${endpoint} did not answer with JSON: ${snippet(response.bodyText)}`,
    };
  }
  if (body.error !== undefined) {
    return {
      error: `MCP initialize at ${endpoint} was rejected: ${describeJsonRpcError(body.error)}`,
    };
  }
  const result = asRecord(body.result);
  const negotiated = result?.protocolVersion;
  if (typeof negotiated !== "string") {
    return {
      error: `MCP initialize at ${endpoint} answered without a protocolVersion: ${snippet(response.bodyText)}`,
    };
  }
  // Adopting whatever came back would make the runner declare a version the
  // endpoint then rejects on the next request, and the resulting 400 would read
  // as if the scenario sent a bad header.
  if (!(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
    return {
      error:
        `MCP initialize at ${endpoint} negotiated protocol version ${JSON.stringify(negotiated)}, ` +
        `which pracht eval does not speak. Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}.`,
    };
  }
  session.protocolVersion = negotiated;

  // The spec's post-handshake notification. It carries no id, so the server
  // answers 202 with no body; a failure here surfaces on the first tools/call.
  await mcpRequest(session, {
    method: "notifications/initialized",
    notification: true,
    sign: scenario.signAs !== undefined,
    signLabel: "the MCP initialized notification",
  });

  return { session };
}

async function callMcpTool(args: {
  session: McpSession;
  step: EvalStep;
  index: number;
  input: unknown;
  headers: Record<string, string>;
  confirmation: string | undefined;
  sign: boolean;
}): Promise<DispatchResult> {
  const { session, step, index, input, headers, confirmation, sign } = args;
  const toolName = mcpToolName(step.capability);

  // Fail loudly rather than sending a header the projection will drop: a step
  // whose authorization rides on `x-api-key` would otherwise look like it
  // tested something it never sent.
  const unsupported = Object.keys(headers).find(
    (name) => name.toLowerCase() !== MCP_FORWARDED_HEADER,
  );
  if (unsupported) {
    const refused = MCP_REFUSED_HEADERS.includes(unsupported.toLowerCase());
    return {
      error:
        `step ${index + 1} "${step.capability}" sets the "${unsupported}" header, which cannot ` +
        (refused
          ? "reach the capability over MCP: the endpoint refuses the whole request with 403, " +
            "because remote MCP is never browser-originated and never cookie-authenticated."
          : "reach the capability over MCP: the projection synthesizes the capability request " +
            `and copies only "${MCP_FORWARDED_HEADER}", so the header would silently vanish.`) +
        ' Drop it, or run this step with "transport": "http".',
    };
  }

  const response = await mcpRequest(session, {
    method: "tools/call",
    params: {
      name: toolName,
      arguments: input,
      // MCP has no per-call header channel; the projection reads the
      // confirmation token from `_meta` instead.
      ...(confirmation === undefined
        ? {}
        : { _meta: { [MCP_CONFIRMATION_META_KEY]: confirmation } }),
    },
    headers,
    sign,
    signLabel: `step "${step.capability}"`,
  });
  if ("error" in response) return response;
  if (response.status !== 200) {
    return { error: describeMcpEndpointStatus(session.endpoint, response) };
  }

  const body = asRecord(response.body);
  if (!body) {
    return {
      error: `tools/call for "${toolName}" did not answer with JSON-RPC: ${snippet(response.bodyText)}`,
    };
  }
  if (body.error !== undefined) {
    return { error: describeToolCallRejection(step.capability, toolName, body.error) };
  }
  const result = asRecord(body.result);
  if (!result) {
    return {
      error: `tools/call for "${toolName}" answered without a result object: ${snippet(response.bodyText)}`,
    };
  }

  return dispatchFromToolResult(toolName, result, response.status);
}

async function mcpRequest(
  session: McpSession,
  options: {
    method: string;
    params?: unknown;
    headers?: Record<string, string>;
    notification?: boolean;
    sign: boolean;
    signLabel: string;
    declareProtocolVersion?: boolean;
  },
): Promise<McpHttpResponse | { error: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Both media types, as the Streamable HTTP transport requires: Pracht's
    // endpoint is lenient, but a conformant server answers 406 without them.
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.declareProtocolVersion !== false) {
    headers[MCP_PROTOCOL_VERSION_HEADER] = session.protocolVersion;
  }
  // Signed exactly like an HTTP-projection step: per request, against the URL
  // actually being called, because the signature covers `@authority`.
  if (options.sign && session.signAs) {
    const signature = await signRequestHeaders(session.endpoint, session.signAs);
    if ("error" in signature) {
      return { error: `could not sign ${options.signLabel}: ${signature.error}` };
    }
    Object.assign(headers, signature.headers);
  }

  const payload = {
    jsonrpc: "2.0",
    ...(options.notification ? {} : { id: session.nextId++ }),
    method: options.method,
    ...(options.params === undefined ? {} : { params: options.params }),
  };

  let status: number;
  let bodyText: string;
  try {
    const response = await session.fetchImpl(session.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    status = response.status;
    bodyText = await response.text();
  } catch (error: unknown) {
    return {
      error: `request to ${session.endpoint} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let body: unknown;
  if (bodyText.trim() !== "") {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = undefined;
    }
  }
  return { status, body, bodyText };
}

/**
 * Envelope + status view of an MCP tool result, so `expect` means the same
 * thing on both transports: `isError` is the envelope's `ok`,
 * `structuredContent` is its `data`, and the projection's `io.pracht/error`
 * metadata is its `error`.
 *
 * `status` is the deliberate one. Every answered `tools/call` is HTTP 200, so
 * reporting the transport status would make `"status": 200` pass on a call that
 * failed — a silent false green, and the opposite of what the same expectation
 * does over HTTP. The projection sends the capability's dispatch status in
 * `io.pracht/status` precisely so a machine caller can recover it; a failed
 * result without that metadata (a non-Pracht server) reports 500 rather than
 * borrowing the transport's 200, because "the tool failed" must never satisfy a
 * success expectation.
 */
function dispatchFromToolResult(
  toolName: string,
  result: Record<string, unknown>,
  transportStatus: number,
): DispatchOutcome {
  const meta = asRecord(result._meta);

  if (result.isError === true) {
    const metaStatus = meta?.[MCP_STATUS_META_KEY];
    const status = typeof metaStatus === "number" ? metaStatus : 500;
    const error = asRecord(meta?.[MCP_ERROR_META_KEY]);
    if (error && typeof error.code === "string") {
      return {
        status,
        transportStatus,
        envelope: { ok: false, error: error as EvalEnvelope["error"] },
      };
    }
    // A non-Pracht server (or a future projection that drops the metadata)
    // reports errors as prose only; keep the text rather than inventing a code.
    return {
      status,
      transportStatus,
      envelope: {
        ok: false,
        error: {
          code: "mcp_tool_error",
          message: toolResultText(result) || `Tool "${toolName}" reported an error.`,
        },
      },
    };
  }

  // A successful capability dispatch is a 200 on the HTTP projection, and the
  // projection only attaches `io.pracht/status` to failures.
  const status =
    typeof meta?.[MCP_STATUS_META_KEY] === "number" ? (meta[MCP_STATUS_META_KEY] as number) : 200;

  // `structuredContent` is what the projection always sends; the text fallback
  // keeps `output` expectations meaningful against a server that only sends
  // the JSON as content.
  if ("structuredContent" in result) {
    return { status, transportStatus, envelope: { ok: true, data: result.structuredContent } };
  }
  const text = toolResultText(result);
  try {
    return {
      status,
      transportStatus,
      envelope: { ok: true, data: text === "" ? undefined : JSON.parse(text) },
    };
  } catch {
    return { status, transportStatus, envelope: { ok: true, data: text } };
  }
}

function toolResultText(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((entry) => {
      const block = asRecord(entry);
      return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** Turn a non-200 answer from the MCP endpoint into something a scenario author can act on. */
function describeMcpEndpointStatus(endpoint: string, response: McpHttpResponse): string {
  const detail = snippet(response.bodyText);
  switch (response.status) {
    case 404:
      return (
        `${endpoint} returned 404 — the app does not serve remote MCP there. Enable it with ` +
        '`defineApp({ agents: { mcp: {} } })`, or point the scenario at the right path with "mcpPath".'
      );
    case 403:
      return (
        `${endpoint} returned 403 — the MCP projection refuses browser-originated and ` +
        `cookie-authenticated requests. Remove any "cookie"/"origin" step headers. ${detail}`
      );
    case 405:
      return `${endpoint} returned 405 — that path does not accept the JSON-RPC POST an MCP client makes. ${detail}`;
    default:
      return `${endpoint} answered ${response.status} for a JSON-RPC POST. ${detail}`;
  }
}

function describeToolCallRejection(capability: string, toolName: string, error: unknown): string {
  const described = describeJsonRpcError(error);
  if (/unknown tool/i.test(described)) {
    return (
      `the app's MCP endpoint does not serve a tool for capability "${capability}" ` +
      `(expected "${toolName}"). Give the capability \`expose: { mcp: true }\`. If it is ` +
      "destructive, also configure `agents.mcp.destructive`, a confirmation secret, and a " +
      'registered approval store; otherwise run this step over the default "http" transport. ' +
      `Server said: ${described}`
    );
  }
  return `tools/call for "${toolName}" was rejected: ${described}`;
}

function describeJsonRpcError(error: unknown): string {
  const record = asRecord(error);
  if (!record) return JSON.stringify(error);
  const code = typeof record.code === "number" ? record.code : "?";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
  return `JSON-RPC ${code}: ${message}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function snippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
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
