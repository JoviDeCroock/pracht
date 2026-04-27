# TSRX Example

Demonstrates `.tsrx` route modules — TSRX/Ripple-flavoured Preact components —
running side by side with regular `.tsx` routes inside a Pracht app.

There is no special pracht option to enable this: install
[`@tsrx/vite-plugin-preact`](https://github.com/Ripple-TS/ripple) and add it to
your Vite `plugins` array alongside `pracht()`. Pracht's route/shell globs and
server-only export stripping both recognise `.tsrx` automatically.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { tsrxPreact } from "@tsrx/vite-plugin-preact";

export default defineConfig({
  plugins: [tsrxPreact(), pracht()],
});
```

## Layout

- `src/routes/home.tsrx` — a `.tsrx` route with a scoped `<style>` block
- `src/routes/about.tsx` — a regular `.tsx` route, proving the two coexist
- `src/shells/public.tsx` — shared shell

## Commands

- `pnpm pracht dev` — start the dev server
- `pnpm pracht build` — produce a production bundle
- `node dist/server/server.js` — run the built Node server locally
