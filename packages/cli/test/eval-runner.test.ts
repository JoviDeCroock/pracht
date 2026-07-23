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
    status: 200,
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
