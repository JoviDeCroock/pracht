# @pracht/preact-ssr-precompile

Experimental Rolldown/Vite plugin that precompiles safe Preact JSX DOM subtrees
into `preact/jsx-runtime` template calls for faster server-side string rendering.

It targets SSR/SSG server bundles only. Client bundles should keep using the
normal Preact JSX transform so hydration still builds a normal VNode tree.

## Install

```sh
pnpm add -D @pracht/preact-ssr-precompile
```

## Usage

### Vite / Pracht

Place the plugin before `pracht()` or `@preact/preset-vite` so it sees JSX before
the normal Preact transform runs:

```ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";

export default defineConfig({
  plugins: [
    preactSsrPrecompile(),
    pracht(),
  ],
});
```

Pracht also exposes the transform as an opt-in framework flag:

```ts
export default defineConfig({
  plugins: [pracht({ precompileSsrJsx: true })],
});
```

For non-Pracht Vite SSR builds:

```ts
import preact from "@preact/preset-vite";
import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";

export default defineConfig({
  plugins: [preactSsrPrecompile(), preact()],
});
```

By default the transform runs only when Vite calls plugin transforms with
`options.ssr === true`.

### Rolldown server builds

For a dedicated server-only Rolldown build, disable the Vite SSR guard:

```ts
import { defineConfig } from "rolldown";
import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";

export default defineConfig({
  plugins: [preactSsrPrecompile({ ssrOnly: false })],
});
```

## What it does

```tsx
<div class="card">Hello {name}</div>
```

becomes roughly:

```ts
import { jsxTemplate as _jsxTemplate, jsxEscape as _jsxEscape } from "preact/jsx-runtime";

const $$_tpl_1 = ["<div class=\"card\">Hello ", "</div>"];

_jsxTemplate($$_tpl_1, _jsxEscape(name));
```

`preact-render-to-string` recognizes these template VNodes and concatenates the
pre-escaped strings directly, avoiding most VNode/props allocations for static
HTML.

## Safety model

The plugin is conservative. It precompiles lowercase native HTML elements only
and falls back to the normal `jsx()` runtime for cases where Preact has special
SSR semantics, including:

- components and member-expression tags;
- spread props;
- `dangerouslySetInnerHTML`;
- custom elements;
- SVG/MathML;
- `textarea`, `select`, and `option`.

Dynamic children are wrapped in `jsxEscape()`. Dynamic attributes are serialized
with `jsxAttr()`, with extra handling for ARIA and enumerated boolean attributes
so output matches `preact-render-to-string`.

## Options

```ts
preactSsrPrecompile({
  include: [/\.[cm]?[tj]sx$/],
  exclude: [/node_modules/],
  importSource: "preact",
  ssrOnly: true,
  skipElements: ["canvas"],
  dynamicProps: ["data-client"],
});
```

- `include` / `exclude`: Vite filter patterns.
- `importSource`: runtime import source. The plugin imports from
  `${importSource}/jsx-runtime`.
- `ssrOnly`: keep the default `true` for apps. Set to `false` only for dedicated
  server-only builds where transform hooks do not receive an SSR flag.
- `skipElements`: additional lowercase element names that should always fall
  back to normal JSX.
- `dynamicProps`: attributes that should always be emitted through `jsxAttr()`.

## Benchmarks

Run the render-to-string microbenchmark from the workspace root:

```sh
pnpm --filter @pracht/preact-ssr-precompile bench
```

The benchmark compiles the same Preact component twice — once with the normal
automatic JSX transform and once through this precompile transform — then renders
each version with `preact-render-to-string` and reports ops/sec and speedup.
Tune the loop size with `BENCH_ITERATIONS=100000` and the warmup count with
`BENCH_WARMUP=5000`.
