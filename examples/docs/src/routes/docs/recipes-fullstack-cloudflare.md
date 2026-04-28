---
title: Full-Stack Cloudflare
lead: Build a full-stack app on Cloudflare with D1 (SQLite), KV, and R2. This recipe covers project setup, database migrations, and wiring bindings into your loaders and API routes.
breadcrumb: Full-Stack Cloudflare
prev:
  href: /docs/recipes/testing
  title: Testing
next:
  href: /docs/recipes/fullstack-vercel
  title: Full-Stack Vercel
---

## What You Get

Cloudflare Workers give you a global edge runtime with built-in storage primitives:

- **D1** — SQLite databases with zero-latency reads at the edge
- **KV** — Eventually-consistent key-value store for caching and config
- **R2** — S3-compatible object storage for files and uploads

pracht's Cloudflare adapter passes all bindings through to your loaders, API routes, and middleware via `context.env`.

---

## 1. Project Setup

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

---

## 2. Configure Bindings

Add your D1 database and any other bindings to `wrangler.jsonc`:

```json [wrangler.jsonc]
{
  "name": "my-app",
  "main": "dist/server/server.js",
  "assets": { "directory": "dist/client" },
  "compatibility_date": "2024-12-01",
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

Create the D1 database:

```sh
npx wrangler d1 create my-app-db
# Copy the database_id into wrangler.jsonc
```

---

## 3. Database Migrations

Create a `migrations/` directory and add your schema:

```sql [migrations/0001_create_posts.sql]
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Apply migrations locally and remotely:

```sh
# Local development
npx wrangler d1 migrations apply my-app-db --local

# Production
npx wrangler d1 migrations apply my-app-db --remote
```

---

## 4. Type Your Bindings

Create a types file so your loaders and API routes get autocomplete:

```ts [src/env.d.ts]
import "@pracht/core";

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
}

declare module "@pracht/core" {
  interface Register {
    context: {
      env: Env;
      executionContext: ExecutionContext;
    };
  }
}
```

---

## 5. Query D1 in Loaders

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

---

## 6. Mutations via API Routes

```ts [src/api/posts.ts]
import type { ApiRouteArgs } from "@pracht/core";

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

  return new Response(null, {
    status: 302,
    headers: { location: `/posts/${result.meta.last_row_id}` },
  });
}
```

Use a form to submit:

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

---

## 7. Use KV for Caching

KV is great for caching expensive queries or storing configuration:

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

---

## 8. Local Development

The pracht dev server with the Cloudflare adapter runs inside `workerd`, so all bindings work locally:

```sh
pnpm dev
# D1, KV, and R2 bindings are available via wrangler's local emulation
```

---

## 9. Deploy

```sh
pracht build
npx wrangler deploy
```

---

## Tips

- Use `render: "ssr"` for any route that reads from D1 — data changes per request.
- Use parameterized queries (`?` placeholders with `.bind()`) to prevent SQL injection. Never interpolate user input into SQL strings.
- D1 supports transactions via `context.env.DB.batch([...])` for atomic multi-statement writes.
- Use `executionContext.waitUntil()` to run background work (analytics, cache warming) without blocking the response.
