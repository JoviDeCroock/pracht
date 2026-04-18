---
name: add-db
version: 1.0.0
description: |
  Wire Drizzle ORM into a pracht app. Asks the user which database to target
  (Cloudflare D1, PlanetScale, Neon, Supabase, Turso, Postgres, MySQL, SQLite,
  ...) and generates the matching driver setup, schema scaffold, migration
  workflow, and a typed client accessible from loaders, middleware, and API
  routes.
  Use when asked to "add database", "set up Drizzle", "wire D1",
  "add Postgres", "set up an ORM", or "I need a DB".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add Database (Drizzle)

Drizzle works well in pracht because it is small, type-safe, and runs in
both Node and edge runtimes (Cloudflare Workers, Vercel Edge). This skill
sets up the driver, schema directory, migration tooling, and a client
factory wired to the project's adapter.

## Step 1: Pick the target

Use `AskUserQuestion`:

| Provider           | Driver                                   | Adapter notes                |
| ------------------ | ---------------------------------------- | ---------------------------- |
| Cloudflare D1      | `drizzle-orm/d1`                         | Workers binding              |
| Cloudflare Hyperdrive (Postgres) | `drizzle-orm/postgres-js` or `node-postgres` | Workers binding |
| PlanetScale        | `drizzle-orm/planetscale-serverless`     | Works on Node + edge         |
| Neon (Postgres)    | `drizzle-orm/neon-serverless` or `neon-http` | Works on Node + edge     |
| Supabase Postgres  | `drizzle-orm/postgres-js`                | Node + edge (HTTP variant)   |
| Turso (libSQL)     | `drizzle-orm/libsql`                     | Node + edge                  |
| Vanilla Postgres   | `drizzle-orm/node-postgres`              | Node only                    |
| Vanilla MySQL      | `drizzle-orm/mysql2`                     | Node only                    |
| SQLite (better-sqlite3) | `drizzle-orm/better-sqlite3`        | Node only                    |

Cross-check with the project's pracht adapter (`pracht inspect build --json`):
flag mismatches (e.g., `node-postgres` on Cloudflare Workers — won't work).

## Step 2: Install

```bash
pnpm add drizzle-orm <driver>
pnpm add -D drizzle-kit
```

Specific drivers:

- D1: no additional package; uses the Workers binding.
- PlanetScale: `pnpm add @planetscale/database`.
- Neon: `pnpm add @neondatabase/serverless`.
- Postgres / Supabase: `pnpm add postgres` (postgres-js).
- Turso: `pnpm add @libsql/client`.
- node-postgres: `pnpm add pg && pnpm add -D @types/pg`.
- mysql2: `pnpm add mysql2`.
- better-sqlite3: `pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3`.

## Step 3: Schema directory

`src/db/schema.ts`:

```ts
// Postgres example — substitute sqliteTable / mysqlTable for other dialects.
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

For D1/SQLite, use `sqliteTable` from `drizzle-orm/sqlite-core`. For MySQL,
use `mysqlTable` from `drizzle-orm/mysql-core`.

## Step 4: Client factory

`src/db/client.ts`:

```ts
// Example for Postgres on Node:
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

For Cloudflare D1:

```ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import type { LoaderArgs } from "@pracht/core";

export function getDb({ context }: Pick<LoaderArgs<{ DB: D1Database }>, "context">) {
  return drizzle(context.env.DB, { schema });
}
```

For PlanetScale / Neon / Turso, follow the matching driver pattern. The
pattern is:

- **Node + persistent process**: module-level singleton.
- **Edge + per-request context (Cloudflare/Vercel Edge)**: factory called
  with `context` inside the loader.

## Step 5: `drizzle.config.ts`

### Non-D1 providers (Postgres, MySQL, Turso, PlanetScale, Neon, local SQLite)

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql", // or "sqlite" / "mysql"
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### Cloudflare D1

D1 has no TCP endpoint, so drizzle-kit can only *generate* migrations. It
cannot apply them — applying goes through `wrangler` (Step 6):

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
});
```

If you want `drizzle-kit studio` against D1, add a `driver: "d1-http"` block
with Cloudflare account/database/API-token credentials (see Drizzle's D1
docs). Otherwise omit `dbCredentials` entirely — `drizzle-kit generate`
doesn't need them.

## Step 6: Scripts

### Non-D1 providers

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate":  "drizzle-kit migrate",
    "db:push":     "drizzle-kit push",
    "db:studio":   "drizzle-kit studio"
  }
}
```

### Cloudflare D1

`drizzle-kit migrate` does not work against D1 (no TCP). Apply migrations
via `wrangler d1 migrations apply <db-name>`, split into local vs remote so
you can iterate safely against the miniflare D1 before touching production:

```json
{
  "scripts": {
    "db:generate":      "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply <db-name> --local",
    "db:migrate:remote": "wrangler d1 migrations apply <db-name> --remote",
    "db:studio":        "drizzle-kit studio"
  }
}
```

Replace `<db-name>` with the `database_name` from `wrangler.toml`/`.jsonc`.
Omit `db:push` for D1 — the migrations-apply flow is the only supported
path.

## Step 7: Use in a loader

Demonstrate the wired-up usage:

```ts
import type { LoaderArgs } from "@pracht/core";
import { db } from "../db/client"; // or getDb(args) on edge runtimes
import { users } from "../db/schema";

export async function loader(_args: LoaderArgs) {
  const rows = await db.select().from(users).limit(20);
  return { users: rows.map(u => ({ id: u.id, email: u.email })) };
}
```

Note: explicit projection — never spread DB rows into loader return values
(see `audit-secrets`).

## Step 8: Bindings & env vars

- For Cloudflare adapters with D1: add the binding to `wrangler.toml`.
  `migrations_dir` must match the `out` in `drizzle.config.ts` so wrangler
  finds the SQL drizzle-kit emits:
  ```toml
  [[d1_databases]]
  binding = "DB"
  database_name = "my-app"
  database_id = "<id>"
  migrations_dir = "drizzle/migrations"
  ```
- For Node/Vercel: document `DATABASE_URL` in `.env.example`. Add `.env*` to
  `.gitignore` if missing.

## Step 9: Verify

Non-D1:

```bash
pnpm db:generate
pnpm db:push   # or db:migrate after creating one
```

D1:

```bash
pnpm db:generate
pnpm db:migrate:local   # apply to miniflare D1
# when happy:
pnpm db:migrate:remote  # apply to production D1
```

Then run the project's existing tests:

```bash
pnpm test
```

## Rules

1. Always confirm the adapter ↔ driver compatibility before installing.
2. Never spread DB rows into loader return values — project explicitly.
3. For edge runtimes, do not module-cache a connection — use a factory keyed
   by `context.env`.
4. Add `.env*` to `.gitignore` if a connection string is involved.
5. Recommend a migration workflow (`db:migrate`) over `db:push` for
   anything beyond local dev.
6. For D1, apply migrations with `wrangler d1 migrations apply`, not
   `drizzle-kit migrate` — D1 exposes no TCP endpoint and drizzle-kit will
   silently fail to connect. Split into `db:migrate:local` and
   `db:migrate:remote` so the local miniflare DB can be iterated without
   touching production. Ensure `migrations_dir` in `wrangler.toml` matches
   `out` in `drizzle.config.ts`.

$ARGUMENTS
