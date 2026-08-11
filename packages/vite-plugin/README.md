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

## Optional Preact SSR JSX precompile

Pracht can opt into the experimental `@pracht/preact-ssr-precompile` transform for
SSR and SSG server bundles:

```ts
export default defineConfig({
  plugins: [pracht({ precompileSsrJsx: true })],
});
```

The transform turns safe native HTML JSX subtrees into `jsxTemplate()` calls that
`preact-render-to-string` can concatenate directly. Client bundles still use the
normal Preact JSX transform so hydration receives a normal VNode tree.

Pass an options object to tune the transform:

```ts
pracht({
  precompileSsrJsx: {
    skipElements: ["canvas"],
    dynamicProps: ["data-client"],
  },
});
```

Keep it opt-in for now: it is best suited to SSR-heavy pages with large static
DOM subtrees and should be benchmarked against your app before enabling broadly.

## Additional Route Extensions

Use `additionalExtensions` when a Vite plugin compiles route or shell modules
with another file extension. For example, TSRX modules can be enabled with:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { tsrxPreact } from "@tsrx/vite-plugin-preact";

export default defineConfig({
  plugins: [tsrxPreact(), pracht({ additionalExtensions: [".tsrx"] })],
});
```

Extensions must be dot-prefixed. Pracht discovers configured extensions in
route and shell directories for both manifest and pages-router modes, includes
them in dependency optimization, and strips server-only route exports from
client bundles. The companion Vite plugin is still responsible for compiling
the file format, and the app should provide any ambient TypeScript module
declaration that format requires.

## Peer Dependencies

- `vite@^8.0.0`

Target-specific Vite plugins (e.g. `@cloudflare/vite-plugin`) are pulled in by
the adapter package you install (`@pracht/adapter-cloudflare`,
`@pracht/adapter-vercel`, etc.). The default path uses `@pracht/adapter-node`,
which ships as a dependency of this package.

Custom adapters can expose two separate plugin hooks on `PrachtAdapter`:

- `vitePlugins()` for the platform's normal development and build integration.
- `graphVitePlugins()` for metadata-only CLI servers. This optional hook must
  not start runtimes, listeners, persistent workers, or debuggers; use it only
  for safe resolvers or platform-module stubs. When omitted, graph commands
  load no adapter-contributed plugins.
