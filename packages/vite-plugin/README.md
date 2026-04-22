# @pracht/vite-plugin

Vite integration for pracht. Handles virtual module generation, multi-environment builds, and SSG prerendering.

## Install

```bash
npm install @pracht/vite-plugin
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht()],
});
```

## What It Does

- Generates virtual modules (`virtual:pracht/client`, `virtual:pracht/server`) from your route manifest
- Builds client and SSR bundles via Vite's multi-environment mode
- Pre-renders SSG and ISG routes at build time (`prerenderConcurrency` controls parallelism)
- Provides HMR during development

## TSRX (`.tsrx`) Support

`.tsrx` modules — TSRX/Ripple-flavoured Preact components — are supported via
[`@tsrx/vite-plugin-preact`](https://github.com/Ripple-TS/ripple). Install the
plugin alongside `@pracht/vite-plugin` and opt in:

```bash
npm install -D @tsrx/vite-plugin-preact
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ tsrx: true })],
});
```

You can also pass options forwarded to the underlying `tsrxPreact()` plugin:

```ts
pracht({ tsrx: { jsxImportSource: "preact", suspenseSource: "preact-suspense" } });
```

Routes and shells written as `.tsrx` files are auto-discovered exactly like
`.tsx` files (both manifest- and pages-router modes).

## Peer Dependencies

- `vite@^8.0.0`
- `@tsrx/vite-plugin-preact@^0.0.3` (optional, only required when `tsrx: true`)

Target-specific Vite plugins (e.g. `@cloudflare/vite-plugin`) are pulled in by
the adapter package you install (`@pracht/adapter-cloudflare`,
`@pracht/adapter-vercel`, etc.). The default path uses `@pracht/adapter-node`,
which ships as a dependency of this package.
