---
title: Full-stack Vercel
lead: "Build an app on Vercel with Neon Postgres, Upstash Redis, and Blob: provisioning through the Vercel Marketplace and access from loaders and API routes."
---

This recipe builds a posts app on Vercel: a Postgres table read in loaders and written from an API route, with a Redis cache in front of an expensive query. The adapter serves SSG pages from the CDN and runs SSR and API routes in an Edge Function; storage connects through environment variables that Vercel injects when you connect a store to the project.

| Store | SDK | Environment variables |
| --- | --- | --- |
| Postgres (Neon) | `@neondatabase/serverless` | `DATABASE_URL` |
| Redis (Upstash) | `@upstash/redis` | `KV_REST_API_URL`, `KV_REST_API_TOKEN` |
| Blob (file storage) | `@vercel/blob` | `BLOB_READ_WRITE_TOKEN` |

## 1. Set up the project

```sh
# Create a new pracht app
pnpm create pracht my-app
cd my-app

# Install the Vercel adapter and storage SDKs
pnpm add @pracht/adapter-vercel @neondatabase/serverless @upstash/redis
```

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { vercelAdapter } from "@pracht/adapter-vercel";

export default defineConfig({
  plugins: [pracht({ adapter: vercelAdapter() })],
});
```

## 2. Provision storage

In the Vercel dashboard, open **Storage** and add **Neon** (Postgres) and **Upstash** (Redis) from the Marketplace, connecting both to the project. Then link the project and pull its environment:

```sh
npx vercel link
npx vercel env pull .env.local
```

`.env.local` now contains `DATABASE_URL`, `KV_REST_API_URL`, and `KV_REST_API_TOKEN`, plus related connection strings. Production deployments receive the same variables.

## 3. Create the schema

Use any migration tool. This script runs in Node, so it reads `process.env` directly:

```ts [scripts/migrate.ts]
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log("Migration complete");
}

migrate();
```

```sh
# Run locally with .env.local loaded (Node 20.6+)
npx tsx --env-file=.env.local scripts/migrate.ts
```

The script prints `Migration complete`.

## 4. Query Postgres in a loader

Create the clients in one server module. Read credentials from [`serverEnv`](/docs/env) and pass them explicitly: the edge server bundle replaces raw `process.env` reads with an empty object, so `Redis.fromEnv()` and `process.env.DATABASE_URL` find nothing there.

```ts [src/server/db.ts]
import { neon } from "@neondatabase/serverless";
import { Redis } from "@upstash/redis";
import { serverEnv } from "@pracht/core/env/server";

export function sql(strings: TemplateStringsArray, ...params: unknown[]) {
  return neon(serverEnv.DATABASE_URL as string)(strings, ...params);
}

export function redis() {
  return new Redis({
    url: serverEnv.KV_REST_API_URL as string,
    token: serverEnv.KV_REST_API_TOKEN as string,
  });
}
```

The Neon driver queries over HTTPS, so it runs in the Edge Function without a connection pool.

```ts [src/routes/posts.tsx]
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { sql } from "../server/db.ts";

interface Post {
  id: number;
  title: string;
  body: string;
  created_at: string;
}

export async function loader(_args: LoaderArgs) {
  const posts = (await sql`
    SELECT id, title, body, created_at
    FROM posts
    ORDER BY created_at DESC
  `) as Post[];

  return { posts };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      <h1>Posts</h1>
      <ul>
        {data.posts.map((post) => (
          <li key={post.id}>
            {post.title}
            <time>{post.created_at}</time>
          </li>
        ))}
      </ul>
      <a href="/posts/new">New Post</a>
    </div>
  );
}
```

Register the route with `render: "ssr"`: the data changes per request.

## 5. Write from an API route

The `sql` template tag parameterizes every interpolated value, so user input cannot inject SQL:

```ts [src/api/posts.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";
import { sql } from "../server/db.ts";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "");
  const body = String(form.get("body") ?? "");

  if (!title || !body) {
    return Response.json({ error: "Title and body are required" }, { status: 400 });
  }

  await sql`INSERT INTO posts (title, body) VALUES (${title}, ${body})`;

  return redirect("/posts", { request });
}
```

Submit to it with a form:

```tsx [src/routes/posts/new.tsx]
import { Form } from "@pracht/core";

export function Component() {
  return (
    <Form method="post" action="/api/posts">
      <label>
        Title
        <input type="text" name="title" required />
      </label>
      <label>
        Body
        <textarea name="body" required />
      </label>
      <button type="submit">Create Post</button>
    </Form>
  );
}
```

Submitting creates the row and lands back on `/posts`, with the new post first.

## 6. Cache in Redis

Cache an expensive query's result in Redis:

```ts [src/routes/dashboard.tsx]
import type { LoaderArgs } from "@pracht/core";
import { redis, sql } from "../server/db.ts";

interface Stats {
  total: number;
  latest: string | null;
}

export async function loader(_args: LoaderArgs) {
  const cache = redis();

  // Check Redis cache first
  const cached = await cache.get<Stats>("dashboard:stats");
  if (cached) return cached;

  // Expensive query
  const rows = (await sql`
    SELECT COUNT(*)::int AS total, MAX(created_at) AS latest FROM posts
  `) as Stats[];
  const stats = rows[0];

  // Cache for 5 minutes
  await cache.set("dashboard:stats", stats, { ex: 300 });

  return stats;
}
```

## 7. Develop locally

```sh
npx vercel env pull .env.local
pnpm dev
```

> [!WARNING]
> Neon and Upstash are remote even in development, so `pracht dev` reads and writes the same databases as production unless you point `.env.local` at a separate development store.

## 8. Deploy

```sh
pracht build
npx vercel deploy --prebuilt
```

Or connect the repository in the Vercel dashboard to deploy on every push.

## Production notes

- To pass your own values on `context`, give the adapter a `createContext` function; see [Adapters](/docs/adapters).
- ISG routes run as Vercel prerender functions. Set `PRACHT_REVALIDATE_TOKEN` at build time to enable webhook revalidation through `/__pracht/revalidate`.
- Edge Functions have code-size and response-time limits that depend on your plan; see Vercel's [function limits](https://vercel.com/docs/functions/limitations). Keep loaders fast and move heavy work to background jobs.
