import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  capabilityHttpPath,
  collectExpectationFailures,
  findEvalFiles,
  matchesSubset,
  parseScenario,
  resolveStepReferences,
  runScenario,
  waitForServer,
  type EvalScenario,
  type EvalStepResult,
} from "../src/eval-runner.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-eval-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stepResult(overrides: Partial<EvalStepResult> = {}): EvalStepResult {
  return {
    capability: "notes.search",
    transport: "http",
    status: 200,
    transportStatus: 200,
    ok: true,
    latencyMs: 1,
    errorCode: null,
    failures: [],
    resultForReferences: { status: 200, ok: true, data: { notes: [] } },
    ...overrides,
  };
}

describe("matchesSubset", () => {
  it("matches deep subsets of objects", () => {
    expect(matchesSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(matchesSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(matchesSubset({ a: 1 }, { missing: 1 })).toBe(false);
  });

  it("compares arrays element-wise with equal length", () => {
    expect(matchesSubset([{ id: "a", extra: 1 }], [{ id: "a" }])).toBe(true);
    expect(matchesSubset([{ id: "a" }, { id: "b" }], [{ id: "a" }])).toBe(false);
    expect(matchesSubset("nope", [{ id: "a" }])).toBe(false);
  });

  it("compares primitives strictly", () => {
    expect(matchesSubset(1, 1)).toBe(true);
    expect(matchesSubset("1", 1)).toBe(false);
    expect(matchesSubset(null, null)).toBe(true);
  });
});

describe("collectExpectationFailures", () => {
  it("requires an ok envelope when no expectation is declared", () => {
    expect(collectExpectationFailures(undefined, 200, { ok: true })).toEqual([]);
    expect(
      collectExpectationFailures(undefined, 400, { ok: false, error: { code: "invalid_input" } }),
    ).toHaveLength(1);
  });

  it("checks ok, status, errorCode, and output subsets", () => {
    const envelope = { ok: false, error: { code: "confirmation_required" } };
    expect(
      collectExpectationFailures(
        { ok: false, status: 409, errorCode: "confirmation_required" },
        409,
        envelope,
      ),
    ).toEqual([]);
    expect(collectExpectationFailures({ status: 200 }, 409, envelope)).toHaveLength(1);
    expect(collectExpectationFailures({ errorCode: "forbidden" }, 409, envelope)).toHaveLength(1);
    expect(
      collectExpectationFailures({ output: { purged: 1 } }, 200, { ok: true, data: { purged: 2 } }),
    ).toHaveLength(1);
  });
});

describe("resolveStepReferences", () => {
  const prior = [
    stepResult({
      resultForReferences: {
        status: 409,
        ok: false,
        error: { code: "confirmation_required", confirmationToken: "v1.abc.def" },
      },
    }),
  ];

  it("substitutes $steps[n].<path> strings in nested input/headers", () => {
    const resolved = resolveStepReferences(
      {
        headers: { "x-pracht-confirm": "$steps[0].error.confirmationToken" },
        nested: ["$steps[0].status"],
        plain: "unchanged",
      },
      prior,
    );
    expect(resolved).toEqual({
      headers: { "x-pracht-confirm": "v1.abc.def" },
      nested: [409],
      plain: "unchanged",
    });
  });

  it("throws on out-of-range steps and unresolvable paths", () => {
    expect(() => resolveStepReferences("$steps[3].status", prior)).toThrow(/has not run yet/);
    expect(() => resolveStepReferences("$steps[0].error.nope", prior)).toThrow(
      /resolved to undefined/,
    );
  });
});

describe("scenario discovery and parsing", () => {
  it("finds evals/**/*.eval.json when no files are given", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "evals", "nested"), { recursive: true });
    writeFileSync(join(dir, "evals", "a.eval.json"), "{}");
    writeFileSync(join(dir, "evals", "nested", "b.eval.json"), "{}");
    writeFileSync(join(dir, "evals", "ignored.json"), "{}");

    const files = findEvalFiles(dir, []);
    expect(files).toEqual([
      join(dir, "evals", "a.eval.json"),
      join(dir, "evals", "nested", "b.eval.json"),
    ]);
    expect(findEvalFiles(dir, ["explicit.eval.json"])).toEqual([join(dir, "explicit.eval.json")]);
  });

  it("rejects scenarios without a name or steps", () => {
    const dir = makeTempDir();
    const file = join(dir, "bad.eval.json");
    writeFileSync(file, JSON.stringify({ name: "x", steps: [] }));
    expect(() => parseScenario(file)).toThrow(/non-empty "steps"/);
    writeFileSync(file, JSON.stringify({ steps: [{ capability: "a" }] }));
    expect(() => parseScenario(file)).toThrow(/missing a "name"/);
    writeFileSync(file, JSON.stringify({ name: "x", steps: [{}] }));
    expect(() => parseScenario(file)).toThrow(/missing a "capability"/);
  });
});

describe("runScenario", () => {
  it("runs steps in order, resolving references and reporting failures", async () => {
    const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const responses = [
      {
        status: 409,
        body: { ok: false, error: { code: "confirmation_required", confirmationToken: "tok-1" } },
      },
      { status: 200, body: { ok: true, data: { purged: 1 } } },
    ];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      const next = responses[requests.length - 1];
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch;

    const scenario: EvalScenario = {
      name: "purge flow",
      steps: [
        {
          capability: "notes.purge",
          input: { titlePrefix: "x" },
          expect: { errorCode: "confirmation_required", status: 409 },
        },
        {
          capability: "notes.purge",
          input: { titlePrefix: "x" },
          headers: { "x-pracht-confirm": "$steps[0].error.confirmationToken" },
          expect: { ok: true, output: { purged: 1 } },
        },
      ],
    };

    const result = await runScenario(scenario, "purge.eval.json", {
      baseUrl: "http://localhost:3103",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.failures)).toEqual([[], []]);
    expect(requests[0].url).toBe("http://localhost:3103/api/capabilities/notes/purge");
    expect(requests[1].headers["x-pracht-confirm"]).toBe("tok-1");
  });

  it('sets the confirmation header from the "confirm" step field', async () => {
    const requests: { headers: Record<string, string> }[] = [];
    const responses = [
      {
        status: 409,
        body: { ok: false, error: { code: "confirmation_required", confirmationToken: "tok-9" } },
      },
      { status: 200, body: { ok: true, data: { purged: 2 } } },
    ];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      const next = responses[requests.length - 1];
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch;

    const result = await runScenario(
      {
        name: "purge with confirm sugar",
        steps: [
          {
            capability: "notes.purge",
            expect: { errorCode: "confirmation_required" },
          },
          {
            capability: "notes.purge",
            confirm: "$steps[0].error.confirmationToken",
            expect: { ok: true },
          },
        ],
      },
      "purge.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(requests[1].headers["x-pracht-confirm"]).toBe("tok-9");
  });

  it("fails the scenario when an expectation does not hold", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })) as typeof fetch;
    const result = await runScenario(
      { name: "x", steps: [{ capability: "a.b", expect: { ok: false } }] },
      "x.eval.json",
      { baseUrl: "http://localhost", fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.steps[0].failures[0]).toContain("expected ok=false");
  });

  it("surfaces network errors as scenario-level failures", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await runScenario({ name: "x", steps: [{ capability: "a.b" }] }, "x.eval.json", {
      baseUrl: "http://localhost:1",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
  });

  it("maps capability names to default HTTP paths", () => {
    expect(capabilityHttpPath("notes.purge")).toBe("/api/capabilities/notes/purge");
    expect(capabilityHttpPath("ping")).toBe("/api/capabilities/ping");
  });
});

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    jsonrpc: string;
    id?: number;
    method: string;
    params?: { name?: string; arguments?: unknown; _meta?: Record<string, unknown> };
  };
}

type ToolResponder = (
  params: RecordedRequest["body"]["params"],
  index: number,
) => { result?: unknown; error?: unknown };

/** Minimal stand-in for the framework's Streamable HTTP projection. */
function fakeMcpServer(
  respond: ToolResponder,
  options: { negotiatedVersion?: string; initializeStatus?: number; initializeBody?: string } = {},
): { requests: RecordedRequest[]; fetchImpl: typeof fetch } {
  const requests: RecordedRequest[] = [];
  let toolCalls = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
    requests.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });

    if (body.method === "initialize") {
      if (options.initializeStatus !== undefined) {
        return new Response(options.initializeBody ?? "Not Found", {
          status: options.initializeStatus,
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: options.negotiatedVersion ?? "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fake", version: "0.0.0" },
        },
      });
    }
    // Notifications carry no id and get no body, exactly like the projection.
    if (body.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id, ...respond(body.params, toolCalls++) });
  }) as typeof fetch;

  return { requests, fetchImpl };
}

const TEST_AGENT = {
  agent: "https://test-agent.example",
  privateKeyJwk: {
    kty: "OKP",
    crv: "Ed25519",
    d: "JZlLQqnxH-0O_1mfnuqDBB1U5XgqETE5eiRXxXRhZNM",
    x: "s5n91rPm5ymJjl--scT4WWq7HE9kUdj-6sVe5r__xgc",
  },
} as const;

describe("runScenario over the MCP transport", () => {
  it("initializes, then issues each step as a tools/call with the mapped tool name", async () => {
    const { requests, fetchImpl } = fakeMcpServer(
      () => ({
        result: {
          content: [{ type: "text", text: "{}" }],
          structuredContent: { notes: [{ id: "n1", title: "Capabilities" }] },
          isError: false,
        },
      }),
      { negotiatedVersion: "2025-06-18" },
    );

    const scenario: EvalScenario = {
      name: "notes over mcp",
      transport: "mcp",
      steps: [
        {
          capability: "notes.search",
          input: { query: "capabilities" },
          expect: { ok: true, status: 200, output: { notes: [{ title: "Capabilities" }] } },
        },
      ],
    };

    const result = await runScenario(scenario, "mcp.eval.json", {
      baseUrl: "http://localhost:3103",
      fetchImpl,
    });

    expect(result.error).toBe(null);
    expect(result.ok).toBe(true);
    expect(result.steps[0].transport).toBe("mcp");

    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(requests.every((request) => request.url === "http://localhost:3103/mcp")).toBe(true);
    expect(requests[0].body.params).toMatchObject({
      protocolVersion: "2025-11-25",
      clientInfo: { name: "pracht-eval" },
    });
    // Nothing is negotiated before initialize; afterwards every request
    // declares the version the server actually agreed to.
    expect(requests[0].headers["mcp-protocol-version"]).toBeUndefined();
    expect(requests[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(requests[2].body.params).toMatchObject({
      name: "notes_search",
      arguments: { query: "capabilities" },
    });
  });

  it("authenticates the initialize handshake and every later MCP request", async () => {
    const { requests, fetchImpl } = fakeMcpServer(() => ({
      result: { structuredContent: {}, isError: false },
    }));

    const result = await runScenario(
      {
        name: "protected mcp",
        transport: "mcp",
        mcpHeaders: { authorization: "Bearer session-token" },
        steps: [{ capability: "notes.search", headers: { authorization: "Bearer step-token" } }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.error).toBe(null);
    expect(requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer session-token",
      "Bearer session-token",
      "Bearer step-token",
    ]);
  });

  it("explains how to authorize a protected MCP handshake", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({ result: {} }), {
      initializeStatus: 401,
      initializeBody: "Unauthorized",
    });

    const result = await runScenario(
      { name: "protected mcp", transport: "mcp", steps: [{ capability: "notes.search" }] },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.error).toContain("requires authorization");
    expect(result.error).toContain('"mcpHeaders"');
  });

  it("explains how to replace an under-scoped MCP bearer token", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({ result: {} }), {
      initializeStatus: 403,
      initializeBody: JSON.stringify({
        error: "insufficient_scope",
        error_description: "The token is missing required scope(s): notes.write.",
      }),
    });

    const result = await runScenario(
      {
        name: "under-scoped mcp",
        transport: "mcp",
        mcpHeaders: { authorization: "Bearer read-only-token" },
        steps: [{ capability: "notes.search" }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.error).toContain("required OAuth scopes");
    expect(result.error).toContain('update "mcpHeaders"');
    expect(result.error).not.toContain("browser-originated");
  });

  it("maps the capability status out of io.pracht/status, not the JSON-RPC 200", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({
      result: {
        content: [{ type: "text", text: "invalid_input: input did not validate" }],
        isError: true,
        _meta: {
          "io.pracht/status": 400,
          "io.pracht/error": {
            code: "invalid_input",
            message: "input did not validate",
            issues: [{ path: "/query", message: "must be at least 1 character(s) long" }],
          },
        },
      },
    }));

    const result = await runScenario(
      {
        name: "validation over mcp",
        transport: "mcp",
        steps: [
          {
            capability: "notes.search",
            input: { query: "" },
            // The identical expectation the HTTP scenario writes.
            expect: { ok: false, status: 400, errorCode: "invalid_input" },
          },
        ],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].status).toBe(400);
    // The POST itself was a 200; asserting that as `status` would have made
    // `expect: { status: 200 }` pass on a failed call.
    expect(result.steps[0].transportStatus).toBe(200);
    expect(result.steps[0].errorCode).toBe("invalid_input");
    // The reference root keeps the HTTP shape, so `$steps[n].error.*` reads the same.
    expect(result.steps[0].resultForReferences.error).toMatchObject({ code: "invalid_input" });
  });

  it("does not let a success status expectation pass on a failed tools/call", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({
      result: {
        content: [{ type: "text", text: "agent_required: sign this request" }],
        isError: true,
        _meta: {
          "io.pracht/status": 401,
          "io.pracht/error": { code: "agent_required", message: "sign this request" },
        },
      },
    }));

    const result = await runScenario(
      {
        name: "denial over mcp",
        transport: "mcp",
        steps: [
          { capability: "agent.ping", expect: { status: 200 } },
          {
            capability: "agent.ping",
            expect: { ok: false, status: 401, errorCode: "agent_required" },
          },
        ],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].failures).toEqual(["expected status 200, got 401"]);
    // The denial spelled out in full still passes — parity with HTTP.
    expect(result.steps[1].failures).toEqual([]);
  });

  it("reports 500 for a tool error that carries no pracht status metadata", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({
      result: { content: [{ type: "text", text: "boom" }], isError: true },
    }));

    const result = await runScenario(
      {
        name: "foreign server",
        transport: "mcp",
        steps: [{ capability: "notes.search", expect: { status: 200 } }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.steps[0].status).toBe(500);
    expect(result.steps[0].errorCode).toBe("mcp_tool_error");
    expect(result.ok).toBe(false);
  });

  // A destructive MCP round trip uses this slot after the first call returns
  // `confirmation_required`; the server owns the approval-store checks.
  it("puts the confirm shorthand in the tools/call _meta", async () => {
    const { requests, fetchImpl } = fakeMcpServer(() => ({
      result: { structuredContent: { ok: true }, isError: false },
    }));

    const result = await runScenario(
      {
        name: "confirm plumbing over mcp",
        transport: "mcp",
        steps: [{ capability: "notes.tidy", confirm: "v1.token.signature" }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.error).toBe(null);
    const call = requests.at(-1)!;
    expect(call.body.params?._meta).toEqual({ "io.pracht/confirmation": "v1.token.signature" });
  });

  it("fails with an actionable message when the endpoint does not serve the tool", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({
      error: {
        code: -32602,
        message: 'Unknown tool "notes_purge". Known tools: notes_create, notes_search.',
      },
    }));

    const result = await runScenario(
      {
        name: "destructive over mcp",
        transport: "mcp",
        steps: [{ capability: "notes.purge", expect: { ok: true } }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('capability "notes.purge"');
    expect(result.error).toContain("expose: { mcp: true }");
    expect(result.error).toContain("agents.mcp.destructive");
    expect(result.error).toContain("registered approval store");
  });

  it("fails with an actionable message when the app serves no MCP endpoint", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({ result: {} }), { initializeStatus: 404 });

    const result = await runScenario(
      {
        name: "no mcp",
        transport: "mcp",
        steps: [{ capability: "notes.search" }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("http://localhost:3103/mcp returned 404");
    expect(result.error).toContain("agents: { mcp: {} }");
  });

  it("signs every MCP POST with the scenario identity, honouring per-step opt-outs", async () => {
    const { requests, fetchImpl } = fakeMcpServer(() => ({
      result: { structuredContent: { pong: true }, isError: false },
    }));

    const result = await runScenario(
      {
        name: "signed mcp",
        transport: "mcp",
        signAs: TEST_AGENT,
        steps: [
          { capability: "agent.ping", expect: { ok: true } },
          { capability: "agent.ping", sign: false, expect: { ok: true } },
        ],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.error).toBe(null);
    const signed = requests.filter((request) => request.headers["signature-input"] !== undefined);
    // initialize, the initialized notification, and the first tools/call.
    expect(signed).toHaveLength(3);
    expect(signed[0].headers["signature-agent"]).toBe('"https://test-agent.example"');
    expect(requests.at(-1)!.headers["signature-input"]).toBeUndefined();
  });

  it("uses the scenario's mcpPath and falls back to text content", async () => {
    const { requests, fetchImpl } = fakeMcpServer(() => ({
      result: { content: [{ type: "text", text: '{"notes":[]}' }], isError: false },
    }));

    const result = await runScenario(
      {
        name: "custom endpoint",
        transport: "mcp",
        mcpPath: "/agent/mcp",
        steps: [{ capability: "notes.search", expect: { ok: true, output: { notes: [] } } }],
      },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(requests[0].url).toBe("http://localhost:3103/agent/mcp");
  });

  it("refuses step headers the MCP projection would drop or reject", async () => {
    const runWithHeaders = async (headers: Record<string, string>) => {
      const { requests, fetchImpl } = fakeMcpServer(() => ({
        result: { structuredContent: {}, isError: false },
      }));
      const result = await runScenario(
        {
          name: "headers over mcp",
          transport: "mcp",
          steps: [{ capability: "notes.search", headers }],
        },
        "mcp.eval.json",
        { baseUrl: "http://localhost:3103", fetchImpl },
      );
      return { result, requests };
    };

    // Refused by the endpoint outright.
    const cookie = await runWithHeaders({ cookie: "session=abc" });
    expect(cookie.result.ok).toBe(false);
    expect(cookie.result.error).toContain('"cookie" header');
    expect(cookie.result.error).toContain("403");

    // Accepted by the endpoint but never copied into the capability request —
    // the silent case, which must fail rather than look tested.
    const apiKey = await runWithHeaders({ "x-api-key": "secret" });
    expect(apiKey.result.ok).toBe(false);
    expect(apiKey.result.error).toContain('"x-api-key" header');
    expect(apiKey.result.error).toContain("copies only");
    expect(apiKey.result.error).toContain('"transport": "http"');

    // `authorization` is the one header the projection forwards.
    const authorized = await runWithHeaders({ authorization: "Bearer t" });
    expect(authorized.result.error).toBe(null);
    expect(authorized.requests.at(-1)!.headers.authorization).toBe("Bearer t");
  });

  it("sends the Streamable HTTP accept header on every request", async () => {
    const { requests, fetchImpl } = fakeMcpServer(() => ({
      result: { structuredContent: {}, isError: false },
    }));

    await runScenario(
      { name: "accept", transport: "mcp", steps: [{ capability: "notes.search" }] },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers.accept).toBe("application/json, text/event-stream");
    }
  });

  it("refuses a negotiated protocol version it does not speak", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({ result: {} }), {
      negotiatedVersion: "2099-01-01",
    });

    const result = await runScenario(
      { name: "future protocol", transport: "mcp", steps: [{ capability: "notes.search" }] },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('negotiated protocol version "2099-01-01"');
    expect(result.error).toContain("Supported:");
  });

  it("reports the scenario transport even when it fails before any step", async () => {
    const { fetchImpl } = fakeMcpServer(() => ({ result: {} }), { initializeStatus: 404 });

    const result = await runScenario(
      { name: "no mcp", transport: "mcp", steps: [{ capability: "notes.search" }] },
      "mcp.eval.json",
      { baseUrl: "http://localhost:3103", fetchImpl },
    );

    expect(result.steps).toHaveLength(0);
    expect(result.transport).toBe("mcp");
  });
});

describe("MCP scenario validation", () => {
  it("rejects transports, paths, and step fields that cannot apply", () => {
    const dir = makeTempDir();
    const file = join(dir, "mcp.eval.json");
    const base = { name: "x", steps: [{ capability: "notes.search" }] };

    writeFileSync(file, JSON.stringify({ ...base, transport: "grpc" }));
    expect(() => parseScenario(file)).toThrow(/"transport" must be "http" or "mcp"/);

    writeFileSync(file, JSON.stringify({ ...base, mcpPath: "/mcp" }));
    expect(() => parseScenario(file)).toThrow(/"mcpPath" only applies/);

    writeFileSync(file, JSON.stringify({ ...base, mcpHeaders: { authorization: "Bearer t" } }));
    expect(() => parseScenario(file)).toThrow(/"mcpHeaders" only applies/);

    writeFileSync(file, JSON.stringify({ ...base, transport: "mcp", mcpPath: "mcp" }));
    expect(() => parseScenario(file)).toThrow(/absolute path/);

    writeFileSync(
      file,
      JSON.stringify({
        name: "x",
        transport: "mcp",
        steps: [{ capability: "notes.search", path: "/api/custom" }],
      }),
    );
    expect(() => parseScenario(file)).toThrow(/addressed by its projected tool name/);

    writeFileSync(
      file,
      JSON.stringify({ ...base, transport: "mcp", mcpHeaders: { "x-api-key": "secret" } }),
    );
    expect(() => parseScenario(file)).toThrow(/only "authorization" is supported/);

    writeFileSync(
      file,
      JSON.stringify({ ...base, transport: "mcp", mcpHeaders: { authorization: 42 } }),
    );
    expect(() => parseScenario(file)).toThrow(/must be a string/);

    writeFileSync(
      file,
      JSON.stringify({ ...base, transport: "mcp", mcpHeaders: { Authorization: "Bearer t" } }),
    );
    expect(parseScenario(file).mcpHeaders).toEqual({ authorization: "Bearer t" });
  });
});

describe("waitForServer", () => {
  it("resolves ok once the server answers, even with an error status", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await waitForServer("http://localhost:9", {
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("times out with a reason when the server never answers", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const result = await waitForServer("http://localhost:9", {
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout");
    expect(result.reason).toContain("http://localhost:9");
  });

  it("aborts early when the earlyExit callback reports a reason", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    let polls = 0;
    const result = await waitForServer("http://localhost:9", {
      earlyExit: () => (++polls > 1 ? "start command exited" : null),
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ ok: false, reason: "start command exited" });
  });
});
