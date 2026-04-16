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
import pracht from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht()],
});
```

## What It Does

- Generates virtual modules (`virtual:pracht/client`, `virtual:pracht/server`) from your route manifest
- Builds client and SSR bundles via Vite's multi-environment mode
- Pre-renders SSG and ISG routes at build time
- Provides HMR during development

## Peer Dependencies

- `vite@^8.0.0`

Target-specific Vite plugins (e.g. `@cloudflare/vite-plugin`) are pulled in by
the adapter package you install (`@pracht/adapter-cloudflare`,
`@pracht/adapter-vercel`, etc.). The default path uses `@pracht/adapter-node`,
which ships as a dependency of this package.
