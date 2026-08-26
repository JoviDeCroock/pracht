/**
 * Durable approvals for destructive capabilities.
 *
 * The stateless prepare/commit flow in runtime-confirmation.ts proves that a
 * commit is bound to one principal, one capability, and one exact input. Two
 * things it cannot prove on its own:
 *
 *   1. that the token is used only once — an HMAC is verifiable anywhere, so
 *      a captured token replays until it expires, on any replica;
 *   2. that a *person* agreed — the calling agent receives the token and can
 *      immediately hand it back to itself.
 *
 * Registering a {@link CapabilityApprovalStore} closes the replay gap. Prepare
 * records a proposal; commit verifies the HMAC first (so a forged token can
 * never burn a real proposal) and then asks the store to consume it exactly
 * once. Human mode additionally requires an authenticated principal from Web
 * Bot Auth or `setCapabilityApprovalPrincipalResolver()` before an out-of-band
 * decision can authorize the operation.
 *
 * The caller interaction does not change: callers still just echo the
 * confirmation token they were handed. Store-backed tokens use a distinct
 * version and bind the approval mode so older or differently configured
 * replicas reject them instead of bypassing the store.
 */

import { hmacSha256Base64Url, type CapabilityConfirmationMode } from "./runtime-confirmation.ts";
import type {
  CapabilityApprovalConsumeResult,
  CapabilityApprovalPrincipalResolver,
  CapabilityApprovalRecord,
  CapabilityApprovalStore,
  PrachtAgentIdentity,
  PrachtRequestContext,
} from "./types.ts";

// Module-level registration, like `setCapabilityAuditHook` and
// `setCapabilityConfirmationSecret`: the app manifest carries serializable
// data only, so a store or resolver function cannot travel through it.
let approvalStore: CapabilityApprovalStore | null = null;
let approvalPrincipalResolver: CapabilityApprovalPrincipalResolver | null = null;

/**
 * Register the store backing destructive-capability approvals. Call it from a
 * server-only module (a capability module, middleware, or a custom server
 * entry). Passing `null` unregisters.
 */
export function setCapabilityApprovalStore(store: CapabilityApprovalStore | null): void {
  approvalStore = store;
}

export function resolveCapabilityApprovalStore(): CapabilityApprovalStore | null {
  return approvalStore;
}

/**
 * Register a server-only resolver for the application-authenticated identity
 * bound to approval proposals. Human approval without either this identity or
 * a verified agent identity fails closed.
 */
export function setCapabilityApprovalPrincipalResolver<TContext = PrachtRequestContext>(
  resolver: CapabilityApprovalPrincipalResolver<TContext> | null,
): void {
  approvalPrincipalResolver = resolver as CapabilityApprovalPrincipalResolver | null;
}

/**
 * Whether an application principal resolver exists at all. Used by serve-time
 * precondition checks — it says a principal is *possible*, never that one was
 * resolved for a given request.
 */
export function hasCapabilityApprovalPrincipalResolver(): boolean {
  return approvalPrincipalResolver !== null;
}

export interface ResolvedCapabilityApprovalPrincipal {
  /** Identity persisted with the proposal for review and correlation. */
  record: string;
  /** Opaque identity bound into the caller-visible confirmation token. */
  tokenBinding: string;
}

export async function resolveCapabilityApprovalPrincipal<TContext>(options: {
  context: TContext;
  request: Request;
  capability: string;
  agent: PrachtAgentIdentity | null;
  confirmationSecret: string;
}): Promise<ResolvedCapabilityApprovalPrincipal | null> {
  const applicationPrincipal = approvalPrincipalResolver
    ? await approvalPrincipalResolver({
        ...options,
        context: options.context as PrachtRequestContext,
      })
    : null;
  if (
    applicationPrincipal !== null &&
    (typeof applicationPrincipal !== "string" || applicationPrincipal.trim() === "")
  ) {
    throw new Error("the approval principal resolver must return a non-empty string or null");
  }

  const parts: string[] = [];
  if (options.agent) parts.push(`agent:${options.agent.keyId}`);
  if (applicationPrincipal) parts.push(`app:${applicationPrincipal}`);
  if (parts.length === 0) return null;

  // Preserve the original agent-only binding so confirmation tokens remain
  // valid across a rolling upgrade. Application identities are different:
  // they may be internal user or tenant ids, and confirmation-token claims are
  // only encoded, not encrypted, so bind an opaque digest instead.
  if (options.agent && !applicationPrincipal) {
    return { record: parts[0], tokenBinding: parts[0] };
  }
  const record = JSON.stringify(parts);
  return {
    record,
    tokenBinding: `approval:${await hmacSha256Base64Url(options.confirmationSecret, record)}`,
  };
}

/**
 * The proposal id for one destructive operation: a secret-keyed digest over
 * the principal, capability name, input hash, and approval mode. Deriving it
 * means two prepare calls for the same operation address the same proposal,
 * while keying it keeps caller-visible ids from revealing low-entropy
 * application principals through offline guessing.
 */
export async function capabilityApprovalId(
  confirmationSecret: string,
  principal: string,
  capability: string,
  inputHash: string,
  approvalMode: CapabilityConfirmationMode,
): Promise<string> {
  return hmacSha256Base64Url(
    confirmationSecret,
    `pracht-approval-id:${JSON.stringify([principal, capability, inputHash, approvalMode])}`,
  );
}

export interface MemoryApprovalStoreOptions {
  /**
   * Clock override. MUST return **unix seconds**, not milliseconds — every
   * record's `expiresAt` is compared against it, so a millisecond clock makes
   * every proposal look expired and kills every approval. Defaults to
   * `Math.floor(Date.now() / 1000)`.
   */
  now?: () => number;
}

/**
 * In-memory reference implementation.
 *
 * Correct for a single instance, and the semantics every other backend must
 * reproduce — but it is *not* durable: it is lost on restart and not shared
 * across replicas. Use it in tests, in development, and in single-instance
 * deployments; back a multi-replica deployment with a store that has
 * conditional writes.
 */
export function createMemoryApprovalStore(
  options: MemoryApprovalStoreOptions = {},
): CapabilityApprovalStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const records = new Map<string, CapabilityApprovalRecord>();

  // Keep the store's records private. In particular, returning the same object
  // from `get()` or `listPending()` would let application code change a pending
  // proposal to approved without going through `decide()`. Capability inputs
  // use the JSON data model, so structured cloning also isolates nested input.
  const cloneRecord = (record: CapabilityApprovalRecord): CapabilityApprovalRecord =>
    structuredClone(record);

  const sweep = (timestamp: number): void => {
    for (const [id, record] of records) {
      if (record.expiresAt < timestamp) records.delete(id);
    }
  };

  return {
    async create(record) {
      const timestamp = now();
      sweep(timestamp);
      const existing = records.get(record.id);
      if (existing && existing.expiresAt >= timestamp) {
        return cloneRecord(existing);
      }
      const stored = cloneRecord(record);
      records.set(stored.id, stored);
      return cloneRecord(stored);
    },

    async get(id) {
      const record = records.get(id);
      return record ? cloneRecord(record) : null;
    },

    async listPending() {
      const timestamp = now();
      return [...records.values()]
        .filter((record) => record.state === "pending" && record.expiresAt >= timestamp)
        .map(cloneRecord);
    },

    async decide(id, decision, by) {
      const timestamp = now();
      const record = records.get(id);
      if (!record || record.state !== "pending" || record.expiresAt < timestamp) return false;
      records.set(id, { ...record, state: decision, decidedBy: by, decidedAt: timestamp });
      return true;
    },

    // Read and write with no await in between: on a single-threaded runtime
    // that is the compare-and-set the store contract requires.
    async consume(id): Promise<CapabilityApprovalConsumeResult> {
      const timestamp = now();
      const record = records.get(id);
      if (!record) return { ok: false, reason: "unknown" };
      if (record.expiresAt < timestamp) {
        records.delete(id);
        return { ok: false, reason: "expired" };
      }
      if (record.state === "consumed") return { ok: false, reason: "already_used" };
      if (record.state === "rejected") return { ok: false, reason: "rejected" };
      if (record.requiresApproval && record.state !== "approved") {
        return { ok: false, reason: "awaiting_approval" };
      }
      const consumed: CapabilityApprovalRecord = {
        ...record,
        state: "consumed",
      };
      records.set(id, consumed);
      return { ok: true, record: cloneRecord(consumed) };
    },
  };
}

// ---------------------------------------------------------------------------
// SQL-backed store
// ---------------------------------------------------------------------------

/**
 * Parameter placeholder style. `"sqlite"` emits `?` (SQLite, Turso/libSQL,
 * Cloudflare D1); `"postgres"` emits `$1`, `$2`, … (node-postgres, Neon,
 * Supabase).
 */
export type SqlApprovalStoreDialect = "sqlite" | "postgres";

/**
 * Whatever the driver returns from a parameterized statement. Every shape the
 * mainstream drivers produce is accepted, so `execute` can usually be a
 * one-liner around the driver call:
 *
 * - `pg`: `{ rows, rowCount }`
 * - Cloudflare D1 (`.all()`): `{ results, meta: { changes } }`
 * - `better-sqlite3` / `node:sqlite`: `{ changes }` from `run()`, an array from `all()`
 * - libSQL / Turso: `{ rows, rowsAffected }`
 *
 * A bare array is read as rows with no affected-row count — fine for reads,
 * but the conditional writes need the count, so the store throws rather than
 * guessing that a write succeeded.
 */
export interface SqlApprovalStoreResult {
  rows?: readonly unknown[];
  /** Cloudflare D1 names the row array `results`. */
  results?: readonly unknown[];
  rowsAffected?: number;
  /** node-postgres. */
  rowCount?: number | null;
  /** better-sqlite3, node:sqlite. */
  changes?: number | bigint;
  /**
   * Cloudflare D1. Only `changes` is read: `rows_written` is billing-page
   * accounting (index pages touched), not the number of rows a statement
   * matched, so treating it as an affected-row count would report success for
   * a conditional update that changed nothing.
   */
  meta?: { changes?: number };
}

/**
 * Run one parameterized statement. Supplied by the application, so the store
 * needs no driver dependency and works on every runtime.
 */
export type SqlApprovalStoreExecute = (
  sql: string,
  params: unknown[],
) => Promise<SqlApprovalStoreResult | readonly unknown[] | null | undefined>;

export interface SqlApprovalStoreOptions {
  /** Parameterized-query function; see {@link SqlApprovalStoreExecute}. */
  execute: SqlApprovalStoreExecute;
  /** Placeholder style. Default `"sqlite"` (`?`). */
  dialect?: SqlApprovalStoreDialect;
  /**
   * Table holding proposals. Default `"pracht_approvals"`. Interpolated into
   * SQL (identifiers cannot be parameters), so it must be a plain identifier
   * or `schema.identifier`; anything else throws at construction.
   */
  table?: string;
  /**
   * Clock override. MUST return **unix seconds**, not milliseconds — every
   * record's `expiresAt` is compared against it, so a millisecond clock makes
   * every proposal look expired and kills every approval. Defaults to
   * `Math.floor(Date.now() / 1000)`.
   */
  now?: () => number;
  /**
   * Minimum seconds between opportunistic `DELETE`s of expired rows. Default
   * 60; `0` sweeps on every proposal. Expiry is always enforced by the
   * statements themselves — the sweep only reclaims space.
   */
  sweepIntervalSeconds?: number;
}

const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const APPROVAL_COLUMNS =
  "id, principal, capability, input_hash, input, requires_approval, " +
  "created_at, expires_at, state, decided_by, decided_at";

/**
 * Durable approvals over any SQL database, with no driver dependency: pass an
 * `execute(sql, params)` and the store speaks the portable subset that
 * Postgres, SQLite/Turso, and Cloudflare D1 all implement.
 *
 * The two hard requirements of {@link CapabilityApprovalStore} are enforced by
 * the database, not by this code:
 *
 * - `create()` is `INSERT … ON CONFLICT (id) DO UPDATE … WHERE expires_at < now`,
 *   so a live proposal is never overwritten by a concurrent re-prepare; the
 *   conflicting row is read back and returned unchanged.
 * - `consume()` is a single conditional `UPDATE` whose `WHERE` clause carries
 *   the whole eligibility rule (unexpired, not already consumed or rejected,
 *   and approved when the *stored* `requires_approval` says so). Exactly one of
 *   two concurrent commits can affect a row, so exactly one gets `ok: true`.
 *
 * Nothing here uses `RETURNING`: D1 and SQLite before 3.35 do not support it
 * consistently, so the store relies on the affected-row count every driver
 * reports instead. See docs/AGENT_TRUST.md for the table schema, the migration,
 * and per-backend wiring snippets.
 */
export function createSqlApprovalStore(options: SqlApprovalStoreOptions): CapabilityApprovalStore {
  const { execute } = options;
  if (typeof execute !== "function") {
    throw new Error("createSqlApprovalStore({ execute }) requires an execute function.");
  }
  const table = options.table ?? "pracht_approvals";
  const segments = table.split(".");
  if (segments.length > 2 || !segments.every((segment) => SQL_IDENTIFIER_RE.test(segment))) {
    throw new Error(
      `createSqlApprovalStore({ table }) must be a plain SQL identifier or "schema.identifier", ` +
        `got ${JSON.stringify(table)}.`,
    );
  }
  // Postgres refers to the conflict target by its unqualified name inside
  // `ON CONFLICT … DO UPDATE`, even when the table is schema-qualified.
  const tableRef = segments[segments.length - 1];
  const dialect: SqlApprovalStoreDialect = options.dialect ?? "sqlite";
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(
      `createSqlApprovalStore({ dialect }) must be "sqlite" or "postgres", got ${JSON.stringify(dialect)}.`,
    );
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const sweepIntervalSeconds = options.sweepIntervalSeconds ?? 60;
  let nextSweepAt = 0;

  /** Placeholders are 1-based and positional; SQLite ignores the number. */
  const p = (index: number): string => (dialect === "postgres" ? `$${index}` : "?");
  const list = (count: number, from = 1): string =>
    Array.from({ length: count }, (_, offset) => p(from + offset)).join(", ");

  const updatedColumns = [
    "principal",
    "capability",
    "input_hash",
    "input",
    "requires_approval",
    "created_at",
    "expires_at",
    "state",
    "decided_by",
    "decided_at",
  ]
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  const CREATE_SQL =
    `INSERT INTO ${table} (${APPROVAL_COLUMNS}) VALUES (${list(11)}) ` +
    `ON CONFLICT (id) DO UPDATE SET ${updatedColumns} ` +
    `WHERE ${tableRef}.expires_at < ${p(12)}`;
  const SELECT_SQL = `SELECT ${APPROVAL_COLUMNS} FROM ${table} WHERE id = ${p(1)}`;
  const LIST_PENDING_SQL =
    `SELECT ${APPROVAL_COLUMNS} FROM ${table} ` +
    `WHERE state = 'pending' AND expires_at >= ${p(1)} ORDER BY created_at ASC, id ASC`;
  const DECIDE_SQL =
    `UPDATE ${table} SET state = ${p(1)}, decided_by = ${p(2)}, decided_at = ${p(3)} ` +
    `WHERE id = ${p(4)} AND state = 'pending' AND expires_at >= ${p(5)}`;
  // The whole eligibility rule lives in the WHERE clause, so the database — not
  // this process — decides which of two racing commits wins. `requires_approval`
  // is read from the stored row so a replica configured for token mode cannot
  // consume a proposal that was recorded as needing human approval.
  const CONSUME_SQL =
    `UPDATE ${table} SET state = 'consumed' ` +
    `WHERE id = ${p(1)} AND expires_at >= ${p(2)} ` +
    `AND ((requires_approval = 0 AND state IN ('pending', 'approved')) ` +
    `OR (requires_approval = 1 AND state = 'approved'))`;
  const DELETE_SQL = `DELETE FROM ${table} WHERE id = ${p(1)}`;
  const SWEEP_SQL = `DELETE FROM ${table} WHERE expires_at < ${p(1)}`;

  const run = async (sql: string, params: unknown[]): Promise<SqlApprovalStoreResult> => {
    const result = await execute(sql, params);
    if (Array.isArray(result)) return { rows: result };
    return (result ?? {}) as SqlApprovalStoreResult;
  };

  const readRows = (result: SqlApprovalStoreResult): readonly unknown[] =>
    result.rows ?? result.results ?? [];

  const readAffected = (result: SqlApprovalStoreResult, sql: string): number => {
    const candidate =
      result.rowsAffected ??
      (typeof result.rowCount === "number" ? result.rowCount : undefined) ??
      (typeof result.changes === "bigint" ? Number(result.changes) : result.changes) ??
      result.meta?.changes;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new Error(
        "createSqlApprovalStore(): execute() must report how many rows a write affected " +
          "(return the driver result, or `{ rowsAffected }`) — the store's exactly-once " +
          `guarantee is that count. Statement: ${sql}`,
      );
    }
    return candidate;
  };

  const selectRecord = async (id: string): Promise<CapabilityApprovalRecord | null> => {
    const rows = readRows(await run(SELECT_SQL, [id]));
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  };

  const sweep = async (timestamp: number): Promise<void> => {
    if (timestamp < nextSweepAt) return;
    nextSweepAt = timestamp + sweepIntervalSeconds;
    await run(SWEEP_SQL, [timestamp]);
  };

  return {
    async create(record) {
      const timestamp = now();
      await sweep(timestamp);
      const params = [
        record.id,
        record.principal,
        record.capability,
        record.inputHash,
        JSON.stringify(record.input ?? null),
        record.requiresApproval ? 1 : 0,
        record.createdAt,
        record.expiresAt,
        record.state,
        record.decidedBy,
        record.decidedAt,
        timestamp,
      ];

      // Two attempts, because a losing insert can find the conflicting row gone
      // if it expired and was swept in between. The second attempt then wins
      // outright; a third round would mean the clock is going backwards.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const written = readAffected(await run(CREATE_SQL, params), CREATE_SQL);
        if (written > 0) return record;
        const existing = await selectRecord(record.id);
        if (existing) return existing;
      }
      throw new Error(
        `createSqlApprovalStore(): proposal ${JSON.stringify(record.id)} could not be created ` +
          "and no conflicting row was found.",
      );
    },

    async get(id) {
      return selectRecord(id);
    },

    async listPending() {
      const timestamp = now();
      const rows = readRows(await run(LIST_PENDING_SQL, [timestamp]));
      return rows.map(rowToRecord);
    },

    async decide(id, decision, by) {
      const timestamp = now();
      const affected = readAffected(
        await run(DECIDE_SQL, [decision, by, timestamp, id, timestamp]),
        DECIDE_SQL,
      );
      return affected === 1;
    },

    async consume(id): Promise<CapabilityApprovalConsumeResult> {
      const timestamp = now();
      const affected = readAffected(await run(CONSUME_SQL, [id, timestamp]), CONSUME_SQL);
      if (affected === 1) {
        const consumed = await selectRecord(id);
        // The row can only have vanished if it expired on this exact tick and a
        // sweep removed it. Fail closed rather than reporting a consumption we
        // cannot describe.
        if (!consumed) return { ok: false, reason: "expired" };
        return { ok: true, record: { ...consumed, state: "consumed" } };
      }

      // Not eligible: read once more to say *why*. This read never decides
      // anything — the conditional UPDATE above already did.
      const record = await selectRecord(id);
      if (!record) return { ok: false, reason: "unknown" };
      if (record.expiresAt < timestamp) {
        await run(DELETE_SQL, [id]);
        return { ok: false, reason: "expired" };
      }
      if (record.state === "consumed") return { ok: false, reason: "already_used" };
      if (record.state === "rejected") return { ok: false, reason: "rejected" };
      return { ok: false, reason: "awaiting_approval" };
    },
  };
}

/**
 * Drivers disagree about column-name casing, integer representation, and
 * whether JSON columns arrive parsed. Normalize defensively so one store works
 * across `pg`, D1, libSQL, and better-sqlite3 without per-backend adapters.
 */
function rowToRecord(row: unknown): CapabilityApprovalRecord {
  if (!row || typeof row !== "object") {
    throw new Error("createSqlApprovalStore(): execute() must return rows as objects.");
  }
  const source = row as Record<string, unknown>;
  const read = (snake: string, camel: string): unknown =>
    source[snake] !== undefined ? source[snake] : source[camel];

  return {
    id: String(read("id", "id")),
    principal: String(read("principal", "principal")),
    capability: String(read("capability", "capability")),
    inputHash: String(read("input_hash", "inputHash")),
    input: parseStoredInput(read("input", "input")),
    requiresApproval: toBoolean(read("requires_approval", "requiresApproval")),
    createdAt: toSeconds(read("created_at", "createdAt")),
    expiresAt: toSeconds(read("expires_at", "expiresAt")),
    state: String(read("state", "state")) as CapabilityApprovalRecord["state"],
    decidedBy: nullableString(read("decided_by", "decidedBy")),
    decidedAt: nullableSeconds(read("decided_at", "decidedAt")),
  };
}

function parseStoredInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    // A JSON/JSONB column may already hand back a decoded value; anything else
    // is application data we should not silently drop.
    return value;
  }
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return value !== 0;
  return value === "1" || value === "true" || value === "t";
}

/** BIGINT arrives as a string from `pg` and as a bigint from some SQLite modes. */
function toSeconds(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `createSqlApprovalStore(): expected a unix-seconds integer, got ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

function nullableSeconds(value: unknown): number | null {
  return value === null || value === undefined ? null : toSeconds(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
