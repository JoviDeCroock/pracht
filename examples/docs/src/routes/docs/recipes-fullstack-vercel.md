---
title: Full-Stack Vercel
lead: Build a full-stack app on Vercel with Vercel Postgres (Neon), KV (Upstash Redis), and Blob storage. This recipe covers project setup, database provisioning, and accessing services from loaders and API routes.
breadcrumb: Full-Stack Vercel
prev:
  href: /docs/recipes/fullstack-cloudflare
  title: Full-Stack Cloudflare
next:
  href: /docs/migrate/nextjs
  title: Migrate from Next.js
---

## What You Get

Vercel provides managed infrastructure you can connect to from Edge Functions:

- **Vercel Postgres** — Serverless Postgres powered by Neon, accessible via `@vercel/postgres`
- **Vercel KV** — Redis-compatible store powered by Upstash
- **Vercel Blob** — File storage with a simple upload/download API

pracht's Vercel adapter deploys your app as an Edge Function with SSG pages served from the CDN.

---

## 1. Project Setup

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

---

## 2. Provision a Database

Create a Postgres database from the Vercel dashboard or CLI:

```sh
npx vercel link
npx vercel env pull .env.local
```

After linking a Vercel Postgres store, your `.env.local` will contain `POSTGRES_URL` and related connection strings. These are automatically available as environment variables in production.

---

## 3. Database Schema

Use any migration tool you like. Here's a simple approach with `@vercel/postgres`:

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

---

## 4. Type Your Context

```ts [src/env.d.ts]
import "@pracht/core";

declare module "@pracht/core" {
  interface Register {
    context: {
      // Vercel's edge context is available here.
      // Add custom values returned from createContext.
    };
  }
}
```

---

## 5. Query Postgres in Loaders

`@vercel/postgres` reads connection info from environment variables automatically — no binding wiring needed:

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

---

## 6. Mutations via API Routes

```ts [src/api/posts.ts]
import { sql } from "@vercel/postgres";
import type { ApiRouteArgs } from "@pracht/core";

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

  return new Response(null, {
    status: 302,
    headers: { location: `/posts/${rows[0].id}` },
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

## 7. Use Vercel KV for Caching

```sh
pnpm add @vercel/kv
```

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

---

## 8. Local Development

Pull your environment variables and run the dev server:

```sh
npx vercel env pull .env.local
pnpm dev
# Loaders and API routes connect to your Vercel Postgres and KV stores
```

> [!INFO]
> Vercel Postgres and KV connect over the network even in development. Your local dev server talks to the same remote databases as production. Use a separate "preview" database for development if you want isolation.

---

## 9. Deploy

```sh
pracht build
npx vercel deploy --prebuilt
```

Or connect your Git repository in the Vercel dashboard for automatic deployments on push.

---

## Tips

- Use `render: "ssr"` for any route that reads from Postgres — data changes per request.
- The `sql` template tag from `@vercel/postgres` automatically parameterizes queries — it's safe against SQL injection by default.
- Pracht's Vercel adapter targets Edge Functions: pracht prerenders ISG routes at build time, then routes ISG paths through the Edge Function instead of relying on process-local cache state. Use `render: "ssg"` for fully static pages or `render: "ssr"` for per-request freshness.
- Vercel Edge Functions have a 25MB size limit and a 30-second execution timeout. Keep loaders fast and move heavy work to background jobs.
