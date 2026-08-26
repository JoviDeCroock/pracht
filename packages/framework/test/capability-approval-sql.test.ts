/**
 * `createSqlApprovalStore()` against a real SQL engine.
 *
 * The store's whole value is that the *database* enforces exactly-once
 * consumption, so the primary suite runs the real statements through
 * `node:sqlite` rather than a mock that could quietly agree with a buggy
 * implementation. A second, recording-only suite pins the parts a single engine
 * cannot show: Postgres placeholder rendering and the affected-row shapes other
 * drivers report.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import {
  createCapabilityTestHost,
  createSqlApprovalStore,
  setCapabilityApprovalStore,
} from "../src/index.ts";
import { setCapabilityConfirmationSecret } from "../src/runtime-confirmation.ts";
import type { SqlApprovalStoreExecute } from "../src/runtime-approval.ts";
import type {
  CapabilityApprovalRecord,
  CapabilityApprovalStore,
  CapabilityEnvelope,
} from "../src/types.ts";

/** The migration documented in docs/AGENT_TRUST.md, verbatim. */
const MIGRATION = `
CREATE TABLE IF NOT EXISTS pracht_approvals (
  id                TEXT    PRIMARY KEY,
  principal         TEXT    NOT NULL,
  capability        TEXT    NOT NULL,
  input_hash        TEXT    NOT NULL,
  input             TEXT    NOT NULL,
  requires_approval INTEGER NOT NULL,
  created_at        BIGINT  NOT NULL,
  expires_at        BIGINT  NOT NULL,
  state             TEXT    NOT NULL,
  decided_by        TEXT,
  decided_at        BIGINT
);
CREATE INDEX IF NOT EXISTS pracht_approvals_pending ON pracht_approvals (state, expires_at);
CREATE INDEX IF NOT EXISTS pracht_approvals_expires_at ON pracht_approvals (expires_at);
`;

type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  // Older runtimes ship no node:sqlite; the recording suite still runs.
}

let clock = 1_000;
const now = (): number => clock;

function record(overrides: Partial<CapabilityApprovalRecord> = {}): CapabilityApprovalRecord {
  return {
    id: "approval-1",
    principal: "agent:key-1",
    capability: "notes.purge",
    inputHash: "hash-1",
    input: { titlePrefix: "Old" },
    requiresApproval: false,
    createdAt: clock,
    expiresAt: clock + 120,
    state: "pending",
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

/**
 * The wiring snippet the docs give for better-sqlite3 / node:sqlite: reads go
 * through `all()`, writes through `run()` so the driver reports `changes`.
 */
function createSqliteExecute(): {
  execute: SqlApprovalStoreExecute;
  statements: string[];
  close: () => void;
} {
  if (!sqlite) throw new Error("node:sqlite is unavailable");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(MIGRATION);
  const statements: string[] = [];
  const execute: SqlApprovalStoreExecute = async (sql, params) => {
    statements.push(sql);
    // Yield first, so concurrent callers really do interleave around the
    // statement instead of running to completion one after another.
    await Promise.resolve();
    const statement = db.prepare(sql);
    return /^\s*SELECT/i.test(sql)
      ? { rows: statement.all(...(params as never[])) }
      : { changes: statement.run(...(params as never[])).changes };
  };
  return { execute, statements, close: () => db.close() };
}

beforeEach(() => {
  clock = 1_000;
});

describe.skipIf(!sqlite)("createSqlApprovalStore over SQLite", () => {
  let store: CapabilityApprovalStore;
  let statements: string[];
  let close: () => void;

  beforeEach(() => {
    const sqliteExecute = createSqliteExecute();
    statements = sqliteExecute.statements;
    close = sqliteExecute.close;
    store = createSqlApprovalStore({ execute: sqliteExecute.execute, now });
  });

  afterEach(() => close());

  it("round-trips a proposal through the JSON data model", async () => {
    const proposal = record({ input: { titlePrefix: "Old", nested: { list: [1, 2] } } });
    expect(await store.create(proposal)).toEqual(proposal);
    expect(await store.get(proposal.id)).toEqual(proposal);
    expect(await store.get("missing")).toBeNull();
  });

  it("never uses RETURNING — D1 and older SQLite cannot be relied on for it", async () => {
    await store.create(record());
    await store.consume("approval-1");
    await store.listPending();
    expect(statements.some((sql) => /\bRETURNING\b/i.test(sql))).toBe(false);
  });

  it("returns the live proposal unchanged when one already exists", async () => {
    const first = await store.create(record());
    const again = await store.create(record({ expiresAt: first.expiresAt + 600, input: "other" }));

    // Re-preparing must not extend a proposal's life or rewrite its input.
    expect(again).toEqual(first);
    expect(await store.get("approval-1")).toEqual(first);
  });

  it("does not resurrect a consumed proposal", async () => {
    await store.create(record());
    expect(await store.consume("approval-1")).toMatchObject({ ok: true });

    const reprepared = await store.create(record());
    expect(reprepared.state).toBe("consumed");
    expect(await store.consume("approval-1")).toEqual({ ok: false, reason: "already_used" });
  });

  it("replaces an expired proposal so the operation can be proposed again", async () => {
    await store.create(record());
    clock += 200;

    const fresh = await store.create(record());
    expect(fresh.state).toBe("pending");
    expect(fresh.expiresAt).toBe(clock + 120);
    expect(await store.consume("approval-1")).toMatchObject({ ok: true });
  });

  it("lets exactly one of two concurrent consumes win", async () => {
    await store.create(record());

    const results = await Promise.all([store.consume("approval-1"), store.consume("approval-1")]);
    const winners = results.filter((result) => result.ok);

    expect(winners).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  it("lets exactly one consume win against ten concurrent commits", async () => {
    await store.create(record());
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consume("approval-1")),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("reports why an ineligible proposal cannot be consumed", async () => {
    expect(await store.consume("approval-1")).toEqual({ ok: false, reason: "unknown" });

    await store.create(record({ requiresApproval: true }));
    expect(await store.consume("approval-1")).toEqual({ ok: false, reason: "awaiting_approval" });

    expect(await store.decide("approval-1", "rejected", "reviewer@example")).toBe(true);
    expect(await store.consume("approval-1")).toEqual({ ok: false, reason: "rejected" });
  });

  it("consumes an approved proposal and records the decision", async () => {
    await store.create(record({ requiresApproval: true }));
    expect(await store.decide("approval-1", "approved", "reviewer@example")).toBe(true);
    // A second decision on a decided proposal is refused.
    expect(await store.decide("approval-1", "rejected", "someone@example")).toBe(false);

    const consumed = await store.consume("approval-1");
    expect(consumed).toMatchObject({
      ok: true,
      record: { state: "consumed", decidedBy: "reviewer@example", decidedAt: 1_000 },
    });
  });

  it("enforces the stored approval requirement, not the caller's mode", async () => {
    // A replica configured for token mode must not consume a proposal that was
    // recorded as needing human approval.
    await store.create(record({ requiresApproval: true }));
    expect(await store.consume("approval-1")).toEqual({ ok: false, reason: "awaiting_approval" });
  });

  it("rejects and cleans up expired proposals", async () => {
    await store.create(record());
    clock += 500;

    expect(await store.consume("approval-1")).toEqual({ ok: false, reason: "expired" });
    // The failed consume drops the dead row rather than leaving it to rot.
    expect(await store.get("approval-1")).toBeNull();
  });

  it("sweeps expired rows opportunistically on create", async () => {
    await store.create(record({ id: "old-1" }));
    await store.create(record({ id: "old-2" }));
    clock += 500;

    await store.create(record({ id: "fresh" }));
    expect(await store.get("old-1")).toBeNull();
    expect(await store.get("old-2")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
  });

  it("lists only undecided, unexpired proposals in creation order", async () => {
    await store.create(record({ id: "a", requiresApproval: true, createdAt: 1_000 }));
    await store.create(record({ id: "b", requiresApproval: true, createdAt: 1_001 }));
    await store.create(record({ id: "c", requiresApproval: true, createdAt: 1_002 }));
    await store.decide("b", "approved", "reviewer@example");

    expect((await store.listPending()).map((entry) => entry.id)).toEqual(["a", "c"]);

    clock += 500;
    expect(await store.listPending()).toEqual([]);
  });

  it("honours a custom table name", async () => {
    const sqliteExecute = createSqliteExecute();
    await sqliteExecute.execute(
      MIGRATION.replaceAll("pracht_approvals", "approvals_v2").split(";")[0],
      [],
    );
    const custom = createSqlApprovalStore({
      execute: sqliteExecute.execute,
      table: "approvals_v2",
      now,
    });
    await custom.create(record());
    expect(await custom.get("approval-1")).not.toBeNull();
    sqliteExecute.close();
  });

  it("drives the destructive prepare/commit gate end to end", async () => {
    setCapabilityConfirmationSecret("sql-approval-store-secret");
    setCapabilityApprovalStore(store);

    const purged: string[] = [];
    const purge = defineCapability({
      title: "Purge notes",
      description: "Delete notes by title prefix.",
      input: {
        type: "object",
        properties: { titlePrefix: { type: "string", minLength: 1 } },
        required: ["titlePrefix"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { purged: { type: "integer" } }, required: ["purged"] },
      effect: "destructive",
      expose: { http: true },
      async run({ input }) {
        purged.push((input as { titlePrefix: string }).titlePrefix);
        return { purged: purged.length };
      },
    });
    const host = createCapabilityTestHost({ capabilities: { "notes.purge": purge } });

    const prepared = (await (
      await host.request("notes.purge", { titlePrefix: "Old" })
    ).json()) as CapabilityEnvelope;
    if (prepared.ok) throw new Error("prepare should not have run the capability");
    const token = prepared.error.confirmationToken!;
    expect(purged).toEqual([]);

    const commit = await host.request(
      "notes.purge",
      { titlePrefix: "Old" },
      { headers: { "x-pracht-confirm": token } },
    );
    expect(commit.status).toBe(200);
    expect(purged).toEqual(["Old"]);

    // Exactly-once: the same token cannot run it again.
    const replay = (await (
      await host.request(
        "notes.purge",
        { titlePrefix: "Old" },
        { headers: { "x-pracht-confirm": token } },
      )
    ).json()) as CapabilityEnvelope;
    expect(replay).toMatchObject({ ok: false, error: { code: "confirmation_invalid" } });
    expect(purged).toEqual(["Old"]);

    setCapabilityApprovalStore(null);
    setCapabilityConfirmationSecret(null);
  });
});

// ---------------------------------------------------------------------------
// Driver portability
// ---------------------------------------------------------------------------

describe("createSqlApprovalStore driver portability", () => {
  /** Captures SQL and answers with whatever result shape a driver would. */
  function recording(result: (sql: string) => unknown) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const execute: SqlApprovalStoreExecute = async (sql, params) => {
      calls.push({ sql, params });
      return result(sql) as never;
    };
    return { calls, execute };
  }

  it("renders numbered placeholders for postgres", async () => {
    const { calls, execute } = recording((sql) =>
      /^\s*SELECT/i.test(sql) ? { rows: [] } : { rowCount: 1 },
    );
    const store = createSqlApprovalStore({ execute, dialect: "postgres", now });
    await store.create(record());

    const insert = calls.find((call) => call.sql.startsWith("INSERT"))!;
    expect(insert.sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)");
    expect(insert.sql).toContain("WHERE pracht_approvals.expires_at < $12");
    expect(insert.params).toHaveLength(12);
    // Booleans travel as 0/1 so one DDL works on Postgres and SQLite alike.
    expect(insert.params[5]).toBe(0);
  });

  it("refers to the unqualified table inside ON CONFLICT for a schema-qualified table", async () => {
    const { calls, execute } = recording(() => ({ rowCount: 1 }));
    const store = createSqlApprovalStore({
      execute,
      dialect: "postgres",
      table: "app.pracht_approvals",
      now,
    });
    await store.create(record());

    expect(calls[calls.length - 1].sql).toContain("INSERT INTO app.pracht_approvals");
    expect(calls[calls.length - 1].sql).toContain("WHERE pracht_approvals.expires_at <");
  });

  it("uses `?` placeholders by default", async () => {
    const { calls, execute } = recording(() => ({ changes: 1 }));
    const store = createSqlApprovalStore({ execute, now });
    await store.create(record());

    const insert = calls.find((call) => call.sql.startsWith("INSERT"))!;
    expect(insert.sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    expect(insert.sql).not.toContain("$1");
  });

  it.each([
    ["node-postgres", { rowCount: 1 }],
    ["libSQL", { rowsAffected: 1 }],
    ["better-sqlite3", { changes: 1 }],
    ["node:sqlite bigint", { changes: 1n }],
    ["Cloudflare D1", { results: [], meta: { changes: 1 } }],
  ])("reads the affected-row count reported by %s", async (_driver, result) => {
    const { execute } = recording(() => result);
    const store = createSqlApprovalStore({ execute, now });
    expect(await store.decide("approval-1", "approved", "reviewer@example")).toBe(true);
  });

  it("reads rows from `rows`, `results`, or a bare array", async () => {
    const row = {
      id: "approval-1",
      principal: "agent:key-1",
      capability: "notes.purge",
      input_hash: "hash-1",
      input: '{"titlePrefix":"Old"}',
      requires_approval: 0,
      // `pg` hands BIGINT back as a string.
      created_at: "1000",
      expires_at: "1120",
      state: "pending",
      decided_by: null,
      decided_at: null,
    };
    for (const result of [{ rows: [row] }, { results: [row] }, [row]]) {
      const { execute } = recording(() => result);
      const store = createSqlApprovalStore({ execute, now });
      expect(await store.get("approval-1")).toEqual(record());
    }
  });

  it("accepts native booleans and pre-parsed JSON columns", async () => {
    const { execute } = recording(() => ({
      rows: [
        {
          id: "approval-1",
          principal: "agent:key-1",
          capability: "notes.purge",
          inputHash: "hash-1",
          input: { titlePrefix: "Old" },
          requiresApproval: true,
          createdAt: 1_000,
          expiresAt: 1_120,
          state: "approved",
          decidedBy: "reviewer@example",
          decidedAt: 1_010,
        },
      ],
    }));
    const store = createSqlApprovalStore({ execute, now });

    expect(await store.get("approval-1")).toEqual(
      record({
        requiresApproval: true,
        state: "approved",
        decidedBy: "reviewer@example",
        decidedAt: 1_010,
      }),
    );
  });

  it("fails closed when execute() cannot report affected rows", async () => {
    const { execute } = recording(() => ({ rows: [] }));
    const store = createSqlApprovalStore({ execute, now });
    await expect(store.consume("approval-1")).rejects.toThrow(/how many rows a write affected/);
  });

  it("fails closed when a conditional insert finds no conflicting row", async () => {
    const { execute } = recording((sql) =>
      /^\s*SELECT/i.test(sql) ? { rows: [] } : { rowsAffected: 0 },
    );
    const store = createSqlApprovalStore({ execute, now });
    await expect(store.create(record())).rejects.toThrow(/could not be created/);
  });

  it("rejects a table name that is not a plain SQL identifier", () => {
    for (const table of ["users; DROP TABLE x", "a.b.c", "", '"quoted"', "1abc"]) {
      expect(() => createSqlApprovalStore({ execute: async () => ({}), table })).toThrow(
        /plain SQL identifier/,
      );
    }
    expect(() =>
      createSqlApprovalStore({ execute: async () => ({}), table: "app.pracht_approvals" }),
    ).not.toThrow();
  });

  it("rejects an unknown dialect and a missing execute", () => {
    expect(() =>
      createSqlApprovalStore({ execute: async () => ({}), dialect: "mysql" as never }),
    ).toThrow(/"sqlite" or "postgres"/);
    expect(() => createSqlApprovalStore({ execute: undefined as never })).toThrow(
      /requires an execute function/,
    );
  });
});
