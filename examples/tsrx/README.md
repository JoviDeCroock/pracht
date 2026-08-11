# TSRX Example

Demonstrates `.tsrx` route modules — TSRX/Ripple-flavoured Preact components —
running side by side with regular `.tsx` routes inside a Pracht app.

Install [`@tsrx/vite-plugin-preact`](https://github.com/Ripple-TS/ripple), add it
to your Vite `plugins` array, and optionally list `.tsrx` through Pracht's
format-agnostic `additionalExtensions` option. This example uses the explicit
form; implicit `.tsrx` discovery remains available for backward compatibility.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { tsrxPreact } from "@tsrx/vite-plugin-preact";

export default defineConfig({
  plugins: [tsrxPreact(), pracht({ additionalExtensions: [".tsrx"] })],
});
```

The format plugin remains responsible for compiling `.tsrx`; Pracht discovers
the modules, applies its usual route client/server handling, and retains the
ambient `.tsrx` module declaration shipped for compatibility.

## Layout

- `src/routes/home.tsrx` — a `.tsrx` route with a scoped `<style>` block
- `src/routes/about.tsx` — a regular `.tsx` route, proving the two coexist
- `src/shells/public.tsx` — shared shell

## Commands

- `pnpm pracht dev` — start the dev server
- `pnpm pracht build` — produce a production bundle
- `node dist/server/server.js` — run the built Node server locally
