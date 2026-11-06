---
title: Full-stack Cloudflare
lead: "Build an app on Cloudflare Workers with D1, KV, and R2: setup, migrations, and bindings in loaders and API routes."
---

This recipe builds a posts app on Cloudflare Workers: a D1 database read in loaders and written from an API route, with a KV cache in front of an expensive query.

The Cloudflare adapter passes every binding to loaders, API routes, and middleware as `context.env`:

| Binding | Use it for |
| --- | --- |
| D1 | SQLite database |
| KV | Eventually consistent key-value store for caching and config |
| R2 | S3-compatible object storage for files and uploads; bind it with `r2_buckets` in `wrangler.jsonc` |

## 1. Set up the project

```sh
# Create a new pracht app
pnpm create pracht my-app
cd my-app

# Install the Cloudflare adapter
pnpm add @pracht/adapter-cloudflare
```

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
```

## 2. Configure bindings

Create the D1 database, then copy the `database_id` it prints into `wrangler.jsonc`:

```sh
npx wrangler d1 create my-app-db
```

```jsonc [wrangler.jsonc]
{
  "name": "my-app",
  "compatibility_date": "2026-04-06",
  "assets": {
    "binding": "ASSETS",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": ["/*", "!/assets/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "<your-database-id>"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "CACHE",
      "id": "<your-kv-namespace-id>"
    }
  ]
}
```

## 3. Run migrations

Add the schema to a `migrations/` directory:

```sql [migrations/0001_create_posts.sql]
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Apply it locally and in production:

```sh
# Local development
npx wrangler d1 migrations apply my-app-db --local

# Production
npx wrangler d1 migrations apply my-app-db --remote
```

## 4. Type your bindings

Generate types from `wrangler.jsonc`:

```sh
npx wrangler types
```

This writes `worker-configuration.d.ts` with the Workers runtime types (`D1Database`, `KVNamespace`, `ExecutionContext`) and an `Env` interface for your bindings, along these lines:

```ts [worker-configuration.d.ts]
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
  }
}
interface Env extends Cloudflare.Env {}
```

Register it so `context.env.DB` and `context.env.CACHE` autocomplete:

```ts [src/env.d.ts]
import "@pracht/core";

declare module "@pracht/core" {
  interface Register {
    context: {
      env: Env;
      executionContext: ExecutionContext;
    };
  }
}
```

Rerun `wrangler types` whenever you add a binding. A `create-pracht` app runs it as `cf-typegen` and before every `typecheck`.

## 5. Query D1 in a loader

```ts [src/routes/posts.tsx]
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

interface Post {
  id: number;
  title: string;
  body: string;
  created_at: string;
}

export async function loader({ context }: LoaderArgs) {
  const { results } = await context.env.DB.prepare(
    "SELECT id, title, body, created_at FROM posts ORDER BY created_at DESC"
  ).all<Post>();

  return { posts: results };
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

Register the route with `render: "ssr"`: D1 data changes per request.

## 6. Write from an API route

```ts [src/api/posts.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";

export async function POST({ request, context }: ApiRouteArgs) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "");
  const body = String(form.get("body") ?? "");

  if (!title || !body) {
    return Response.json({ error: "Title and body are required" }, { status: 400 });
  }

  const result = await context.env.DB.prepare("INSERT INTO posts (title, body) VALUES (?, ?)")
    .bind(title, body)
    .run();

  return redirect(`/posts/${result.meta.last_row_id}`, { request });
}
```

Always pass user input through `?` placeholders and `.bind()`; never interpolate it into SQL strings. For atomic multi-statement writes, use `context.env.DB.batch([...])`.

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

## 7. Cache in KV

Cache an expensive query's result in KV:

```ts [src/routes/dashboard.tsx]
import type { LoaderArgs } from "@pracht/core";

export async function loader({ context }: LoaderArgs) {
  // Check KV cache first
  const cached = await context.env.CACHE.get("dashboard:stats", "json");
  if (cached) return cached;

  // Expensive query
  const stats = await context.env.DB.prepare(
    "SELECT COUNT(*) as total, MAX(created_at) as latest FROM posts",
  ).first();

  // Cache for 5 minutes
  await context.env.CACHE.put("dashboard:stats", JSON.stringify(stats), {
    expirationTtl: 300,
  });

  return stats;
}
```

To write the cache without delaying the response, pass the `put()` promise to the loader's `waitUntil()` argument instead of awaiting it.

## 8. Develop locally

```sh
pnpm dev
```

With the Cloudflare adapter, `pracht dev` runs your app inside `workerd`, so D1, KV, and R2 bindings use wrangler's local emulation.

## 9. Deploy

```sh
pracht build
npx wrangler deploy
```
