# @pracht/core

## 0.2.5

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

## 0.2.4

### Patch Changes

- [#88](https://github.com/JoviDeCroock/pracht/pull/88) [`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257) Thanks [@kinngh](https://github.com/kinngh)! - Add shell and route `headers()` exports for page document responses. Headers merge like `head()` metadata, are preserved in prerender output, and are applied to static SSG/ISG HTML served by the built-in adapters.

## 0.2.3

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix production asset metadata wiring so built SSR and prerendered pages use hashed client entries and modulepreload hints consistently.

- [#82](https://github.com/JoviDeCroock/pracht/pull/82) [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Normalize module paths once via `normalizeModulePath` instead of duplicating `./` and `/` stripping across manifest and registry lookups. Adds a cached suffix index for O(1) manifest resolution.

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Performance optimizations for SSR runtime and Node adapter

  - Cache `preact-render-to-string` dynamic import to avoid repeated async resolution per request
  - Replace O(n) suffix matching in module registry and CSS/JS manifest lookups with pre-built WeakMap indexes for O(1) resolution
  - Parallelize SSG prerendering with batched concurrency (10 pages at a time)
  - Switch Node adapter from sync fs operations (statSync, writeFileSync, existsSync) to async equivalents to avoid blocking the event loop
  - Reduce Response object allocations by combining security and route header application into a single pass

## 0.2.2

### Patch Changes

- [#79](https://github.com/JoviDeCroock/pracht/pull/79) [`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a) Thanks [@kinngh](https://github.com/kinngh)! - Allow API route modules to export a default handler that branches on `request.method`.

## 0.2.1

### Patch Changes

- [#76](https://github.com/JoviDeCroock/pracht/pull/76) [`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Two `useIsHydrated` correctness fixes:

  1. **Mid-tree sibling race.** Sibling components rendered in the same hydrate
     call could disagree about whether hydration had finished because the global
     `_hydrated` flag was flipped from `options.diffed` (per vnode). The earlier
     sibling's `diffed` would fire before the later sibling's render, so the
     later sibling read `true` from `useState(_hydrated)` during its very first
     render. Moved the flip to `options._commit` (commit root), which fires once
     per commit after the whole tree has diffed. This also handles Suspense
     resolution transparently — when a lazy boundary settles, its re-render
     goes through a normal diff→commit cycle and `_commit` catches it at the
     end.

  2. **Non-hydrating suspensions were counted as hydration-suspensions.**
     `options._catchError` was counting every thrown promise while the global
     `_hydrating` flag was true, so a parallel `render()` tree (portal, modal
     root, island) that suspended during the hydration window would pin
     `_hydrated` at `false` forever. The counter now only increments when the
     thrown promise originates from a vnode that actually carries
     `MODE_HYDRATE`, matching the check preact-suspense itself uses to decide
     whether to preserve server DOM.

## 0.2.0

### Minor Changes

- [#73](https://github.com/JoviDeCroock/pracht/pull/73) [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `useIsHydrated` hook that tracks in-flight Suspense boundaries during hydration and returns `true` only after the initial hydration (including all suspended promises) has fully resolved.

### Patch Changes

- [#75](https://github.com/JoviDeCroock/pracht/pull/75) [`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21) Thanks [@kinngh](https://github.com/kinngh)! - Allow route modules to use a function default export as the page component while preserving named route exports.

## 0.1.0

### Minor Changes

- [#65](https://github.com/JoviDeCroock/pracht/pull/65) [`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Export `forwardRef` utility so users can forward refs through wrapper components without depending on `preact/compat`.

- [#12](https://github.com/JoviDeCroock/pracht/pull/12) [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support `() => import("./path")` syntax in route manifests for IDE click-to-navigate

- [#52](https://github.com/JoviDeCroock/pracht/pull/52) [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Parallelize route-state fetch and module imports during client-side navigation. Route and shell chunks now start loading at the same time as the data fetch instead of waiting for it to complete. Prefetching also warms module imports alongside route-state data. Shell modules are cached to avoid re-importing on repeated navigations.

- [#55](https://github.com/JoviDeCroock/pracht/pull/55) [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Improve SPA first paint by rendering the matched shell during the initial HTML response and supporting an optional shell `Loading` export for immediate placeholder UI while route-state data loads on the client.

### Patch Changes

- [#63](https://github.com/JoviDeCroock/pracht/pull/63) [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Separate HTML and route-state cache variants across framework responses and build outputs.

  Page responses now vary on `x-pracht-route-state-request`, framework-generated
  route-state responses default to `Cache-Control: no-store`, and Node/preview
  cached HTML paths no longer intercept route-state fetches. Vercel build output
  now routes route-state requests to the edge function before static rewrites.

- [#49](https://github.com/JoviDeCroock/pracht/pull/49) [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Handle malformed percent-encoding in route matching by catching `decodeURIComponent` failures and treating them as non-matches instead of throwing uncaught `URIError` exceptions.

- [#59](https://github.com/JoviDeCroock/pracht/pull/59) [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Sanitize unexpected 5xx route errors by default in SSR HTML, route-state JSON,
  and hydration payloads while preserving explicit `PrachtHttpError` 4xx
  messages. Add an explicitly opt-in `debugErrors` escape hatch for local
  debugging and ensure the Vite dev server keeps verbose errors enabled only
  through that option.

- [#71](https://github.com/JoviDeCroock/pracht/pull/71) [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add structured runtime diagnostics to debug route-state, SSR, and API failures.

  `handlePrachtRequest()` now catches middleware and API exceptions earlier in the
  pipeline and, when `debugErrors: true` is enabled, serializes framework
  diagnostics such as the failure phase, matched route metadata, and relevant
  module files alongside the normalized error payload.

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option
