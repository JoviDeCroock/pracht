# @pracht/adapter-void

Void adapter for pracht. Emits a Cloudflare Worker-compatible server entry and
static assets that `void deploy --skip-build` can package.

## Install

```bash
npm install @pracht/adapter-void void
```

## Usage

```ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { voidAdapter } from "@pracht/adapter-void";

export default defineConfig({
  plugins: [pracht({ adapter: voidAdapter() })],
});
```

Add a `void.json` with Workers compatibility settings:

```json
{
  "$schema": "./node_modules/void/schema.json",
  "worker": {
    "compatibility_date": "2026-02-24",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

Build with Pracht, then deploy the existing output:

```bash
pracht build
void deploy --skip-build
```

## Bindings

Pracht loaders, middleware, and API routes receive Void/Cloudflare bindings on
`context.env`. The generated entry also wraps each request with Void's runtime
env context, so default helpers from `void/db`, `void/kv`, `void/storage`, and
`void/env` can resolve bindings.

Void-managed auth routes and middleware are not automatic because Pracht owns
routing. Use Pracht API routes/middleware with your auth library, or wire Better
Auth directly.
