# TSRX Example

Demonstrates `.tsrx` route modules — TSRX/Ripple-flavoured Preact components —
running side by side with regular `.tsx` routes inside a Pracht app.

The integration is opt-in via the `tsrx: true` plugin option:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ tsrx: true })],
});
```

`tsrx: true` loads
[`@tsrx/vite-plugin-preact`](https://github.com/Ripple-TS/ripple) under the
hood; pass an options object instead of `true` to forward
`jsxImportSource` / `suspenseSource` to the underlying plugin.

## Layout

- `src/routes/home.tsrx` — a `.tsrx` route with a scoped `<style>` block
- `src/routes/about.tsx` — a regular `.tsx` route, proving the two coexist
- `src/shells/public.tsx` — shared shell

## Commands

- `pnpm pracht dev` — start the dev server
- `pnpm pracht build` — produce a production bundle
- `node dist/server/server.js` — run the built Node server locally
