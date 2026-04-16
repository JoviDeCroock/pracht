# @pracht/adapter-cloudflare

Cloudflare Workers adapter for pracht. Handles requests in the Workers `fetch` event, serves static assets via `env.ASSETS`, and supports ISG revalidation through KV.

## Install

```bash
npm install @pracht/adapter-cloudflare
```

## Usage

Select the Cloudflare adapter when scaffolding with `create-pracht`, or add it to an existing project:

```bash
npm create pracht@latest my-app  # choose Cloudflare
```

Deploy with:

```bash
pracht build && wrangler deploy
```

Export Durable Objects, Workflows, Queues, and other Cloudflare primitives from
a dedicated module:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [
    pracht({
      adapter: cloudflareAdapter({
        workerExportsFrom: "/src/cloudflare.ts",
      }),
    }),
  ],
});
```

```ts
// src/cloudflare.ts
export { Counter } from "./workers/counter.ts";
```

Keep the matching bindings and migrations in `wrangler.jsonc`.

## Features

- Converts Cloudflare Worker requests to standard Web Requests
- Static asset serving via `env.ASSETS`
- KV-based ISG revalidation
- Execution context passing for Cloudflare-specific APIs
