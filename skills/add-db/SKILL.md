---
name: add-db
version: 1.2.0
description: |
  Wire Drizzle ORM into a pracht app: pick the target (D1, PlanetScale, Neon,
  Supabase, Turso, Postgres, MySQL, SQLite), then generate driver setup, schema,
  migration workflow, and a typed client for loaders, middleware, and API routes.
  Use for "add database", "set up Drizzle", "wire D1", "add Postgres", "set up an
  ORM", "I need a DB".
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

Drizzle suits pracht because it is small, type-safe, and runs in both Node and
edge runtimes. This skill sets up the driver, schema, migration tooling, and a
client factory wired to the project's adapter. Never overwrite an existing
`drizzle.config.ts`, `wrangler.toml`, or `package.json` script — diff, merge,
and ask about collisions.

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/`verify`/`generate_*`
tools over shelling out. `pracht inspect` needs the pracht plugin in the vite
config; `inspect build` needs a prior `pracht build`.

## Step 1: Pick the target

Ask with `AskUserQuestion`, then **cross-check against the project's adapter**
(`pracht inspect build --json`) and flag mismatches — `node-postgres` on
Cloudflare Workers will not work.

| Provider                         | Driver import                                | Extra package | Runtimes |
| -------------------------------- | -------------------------------------------- | ------------- | -------- |
| Cloudflare D1                    | `drizzle-orm/d1`                             | — (Workers binding) | Edge |
| Cloudflare Hyperdrive (Postgres) | `drizzle-orm/postgres-js` or `node-postgres` | `postgres` / `pg` | Edge (binding) |
| PlanetScale                      | `drizzle-orm/planetscale-serverless`         | `@planetscale/database` | Node + edge |
| Neon                             | `drizzle-orm/neon-serverless` or `neon-http` | `@neondatabase/serverless` | Node + edge |
| Supabase Postgres                | `drizzle-orm/postgres-js`                    | `postgres` | Node + edge (HTTP) |
| Turso (libSQL)                   | `drizzle-orm/libsql`                         | `@libsql/client` | Node + edge |
| Vanilla Postgres                 | `drizzle-orm/node-postgres`                  | `pg` + `-D @types/pg` | Node only |
| Vanilla MySQL                    | `drizzle-orm/mysql2`                         | `mysql2` | Node only |
| SQLite                           | `drizzle-orm/better-sqlite3`                 | `better-sqlite3` + `-D @types/better-sqlite3` | Node only |

```bash
pnpm add drizzle-orm <driver-package>
pnpm add -D drizzle-kit
```

## Step 2: Schema

`src/db/schema.ts` — `pgTable` from `drizzle-orm/pg-core`, `sqliteTable` from
`drizzle-orm/sqlite-core` (D1 and SQLite), or `mysqlTable` from
`drizzle-orm/mysql-core`:

```ts
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

## Step 3: Client factory

Read connection strings via `serverEnv` from `@pracht/core/env/server`, never
`process.env` — it keeps the secret out of the client bundle and resolves per
adapter (docs/ENV.md). The shape depends on the runtime:

- **Node, persistent process** — a module-level singleton is fine, because
  `serverEnv` works at module top level there.
- **Edge with per-request context (Cloudflare, Vercel Edge)** — read
  `serverEnv` or the binding *inside* a factory. Workers env bindings only
  exist per request, so a module-level read bricks the worker at import time.

```ts
// src/db/client.ts — Postgres on Node
import { serverEnv } from "@pracht/core/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: serverEnv.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

For Cloudflare D1, register the Cloudflare context type once via the `Register`
augmentation (the pattern in
`examples/docs/src/routes/docs/recipes-fullstack-cloudflare.md`):

```ts
// src/env.d.ts
declare module "@pracht/core" {
  interface Register {
    context: {
      env: Env; // wrangler-generated bindings type, includes DB: D1Database
      executionContext: ExecutionContext;
    };
  }
}
```

The factory then needs no per-file generics:

```ts
import type { LoaderArgs } from "@pracht/core";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb({ context }: Pick<LoaderArgs, "context">) {
  return drizzle(context.env.DB, { schema });
}
```

Without that augmentation, the inline generic must describe the full context —
`LoaderArgs<{ env: { DB: D1Database }; executionContext: ExecutionContext }>` —
because the context is `{ env, executionContext }`, not the bindings object.

## Step 4: drizzle.config.ts and scripts

`process.env` *is* fine in `drizzle.config.ts`: it runs under the drizzle-kit
CLI on Node, never inside the worker.

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql", // or "sqlite" / "mysql"
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

**D1 is the exception.** It has no TCP endpoint, so drizzle-kit can only
*generate* migrations — applying goes through `wrangler`. Omit `dbCredentials`
entirely (add a `driver: "d1-http"` block with Cloudflare account/database/API
token only if you want `drizzle-kit studio`), and omit `db:push`: the
migrations-apply flow is the only supported path. Split local from remote so
the miniflare D1 can be iterated without touching production.

| Script | Non-D1 | Cloudflare D1 |
| ------ | ------ | ------------- |
| `db:generate` | `drizzle-kit generate` | `drizzle-kit generate` |
| `db:migrate` | `drizzle-kit migrate` | `wrangler d1 migrations apply <db-name> --local` / `--remote` as `db:migrate:local` / `db:migrate:remote` |
| `db:push` | `drizzle-kit push` (local dev only — prefer migrations beyond that) | *omit* |
| `db:studio` | `drizzle-kit studio` | `drizzle-kit studio` |

`<db-name>` is the `database_name` from `wrangler.toml`/`.jsonc`.

## Step 5: Bindings and env

- **Cloudflare D1** — merge the binding into `wrangler.toml`/`.jsonc`.
  `migrations_dir` must match `out` in `drizzle.config.ts` or wrangler will not
  find the SQL drizzle-kit emits:

  ```toml
  [[d1_databases]]
  binding = "DB"
  database_name = "my-app"
  database_id = "<id>"
  migrations_dir = "drizzle/migrations"
  ```

- **Node / Vercel** — document `DATABASE_URL` in `.env.example`, and add
  `.env*` to `.gitignore` if it is missing.

## Step 6: Use it in a loader

```ts
import type { LoaderArgs } from "@pracht/core";
import { db } from "../db/client"; // or getDb(args) on edge runtimes
import { users } from "../db/schema";

export async function loader(_args: LoaderArgs) {
  const rows = await db.select().from(users).limit(20);
  return { users: rows.map((u) => ({ id: u.id, email: u.email })) };
}
```

Project explicitly — never spread DB rows into loader return values, since
everything returned crosses the wire (see `/audit-secrets`).

## Step 7: Verify

```bash
pnpm db:generate
pnpm db:push            # non-D1; or db:migrate once a migration exists
pnpm db:migrate:local   # D1 — then db:migrate:remote when happy
pracht verify --json
pnpm test
```

On a fresh project `pnpm test` is a no-op and proves nothing about the DB
wiring. Suggest a loader smoke test that calls the Step 6 loader against a real
local DB and asserts the returned shape, or run `/scaffold-tests` to set that
up.

$ARGUMENTS
