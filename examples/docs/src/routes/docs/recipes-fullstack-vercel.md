---
title: Full-stack Vercel
lead: "Build an app on Vercel with Postgres (Neon), KV (Upstash Redis), and Blob: setup, provisioning, and access from loaders and API routes."
---

This recipe builds a posts app on Vercel: a Postgres table read in loaders and written from an API route, with a Redis cache in front of an expensive query. The adapter serves SSG pages from the CDN and runs SSR and API routes in an Edge Function; storage connects through environment variables.

| Store | SDK |
| --- | --- |
| Postgres (Neon) | `@vercel/postgres` |
| KV (Upstash Redis) | `@vercel/kv` |
| Blob (file storage) | `@vercel/blob` |

## 1. Set up the project

```sh
# Create a new pracht app
pnpm create pracht my-app
cd my-app

# Install the Vercel adapter and storage SDKs
pnpm add @pracht/adapter-vercel @vercel/postgres @vercel/kv
```

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { vercelAdapter } from "@pracht/adapter-vercel";

export default defineConfig({
  plugins: [pracht({ adapter: vercelAdapter() })],
});
```

## 2. Provision a database

Create a Postgres database in the Vercel dashboard, then link the project and pull its environment:

```sh
npx vercel link
npx vercel env pull .env.local
```

`.env.local` now contains `POSTGRES_URL` and related connection strings. Production deployments receive the same variables.

## 3. Create the schema

Use any migration tool. This script uses `@vercel/postgres` directly:

```ts [scripts/migrate.ts]
import { sql } from "@vercel/postgres";

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
# Run locally with .env.local loaded
npx dotenv -e .env.local -- npx tsx scripts/migrate.ts
```

The script prints `Migration complete`.

## 4. Query Postgres in a loader

`@vercel/postgres` reads its connection string from the environment, so there is no binding to wire:

```ts [src/routes/posts.tsx]
import { sql } from "@vercel/postgres";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

interface Post {
  id: number;
  title: string;
  body: string;
  created_at: string;
}

export async function loader(_args: LoaderArgs) {
  const { rows } = await sql<Post>`
    SELECT id, title, body, created_at
    FROM posts
    ORDER BY created_at DESC
  `;

  return { posts: rows };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      <h1>Posts</h1>
      <ul>
        {data.posts.map((post) => (
          <li key={post.id}>
            <a href={`/posts/${post.id}`}>{post.title}</a>
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
import { sql } from "@vercel/postgres";
import { redirect, type ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "");
  const body = String(form.get("body") ?? "");

  if (!title || !body) {
    return Response.json({ error: "Title and body are required" }, { status: 400 });
  }

  const { rows } = await sql`
    INSERT INTO posts (title, body)
    VALUES (${title}, ${body})
    RETURNING id
  `;

  return redirect(`/posts/${rows[0].id}`, { request });
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

Submitting creates the row and lands on `/posts/<new id>`.

## 6. Cache in KV

Cache an expensive query's result in Redis:

```ts [src/routes/dashboard.tsx]
import { kv } from "@vercel/kv";
import { sql } from "@vercel/postgres";
import type { LoaderArgs } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  // Check Redis cache first
  const cached = await kv.get("dashboard:stats");
  if (cached) return cached;

  // Expensive query
  const { rows } = await sql`
    SELECT COUNT(*) as total, MAX(created_at) as latest FROM posts
  `;
  const stats = rows[0];

  // Cache for 5 minutes
  await kv.set("dashboard:stats", stats, { ex: 300 });

  return stats;
}
```

## 7. Develop locally

```sh
npx vercel env pull .env.local
pnpm dev
```

> [!WARNING]
> Postgres and KV are remote even in development, so `pracht dev` reads and writes the same databases as production unless you point `.env.local` at a separate development store.

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
