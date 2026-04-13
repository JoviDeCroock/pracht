# @pracht/cli

## 1.1.3

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix production asset metadata wiring so built SSR and prerendered pages use hashed client entries and modulepreload hints consistently.

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3

## 1.1.2

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2

## 1.1.1

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1

## 1.1.0

### Minor Changes

- [#70](https://github.com/JoviDeCroock/pracht/pull/70) [`ddd50a1`](https://github.com/JoviDeCroock/pracht/commit/ddd50a1edf82a6884881a91ce7172d87ec571cde) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht inspect` as a machine-readable app graph command.

  The CLI can now emit resolved routes, API handlers, and build metadata via:

  - `pracht inspect routes --json`
  - `pracht inspect api --json`
  - `pracht inspect build --json`
  - `pracht inspect --json`

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0

## 1.0.0

### Major Changes

- [#58](https://github.com/JoviDeCroock/pracht/pull/58) [`6bf6738`](https://github.com/JoviDeCroock/pracht/commit/6bf6738469c8533db2890a89b4edcb92bbbb1011) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add framework-native `pracht generate route|shell|middleware|api` scaffolding commands, add `pracht doctor` with optional JSON output, and remove the Node-specific `pracht preview` command.

### Minor Changes

- [#69](https://github.com/JoviDeCroock/pracht/pull/69) [`527e030`](https://github.com/JoviDeCroock/pracht/commit/527e030017f269b7cff51e96a0bcb98bbd1bff3d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a fast `pracht verify` command with optional `--changed` and `--json`
  output for framework-aware manifest, pages-router, and API route validation.

### Patch Changes

- [#63](https://github.com/JoviDeCroock/pracht/pull/63) [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Separate HTML and route-state cache variants across framework responses and build outputs.

  Page responses now vary on `x-pracht-route-state-request`, framework-generated
  route-state responses default to `Cache-Control: no-store`, and Node/preview
  cached HTML paths no longer intercept route-state fetches. Vercel build output
  now routes route-state requests to the edge function before static rewrites.

- [#62](https://github.com/JoviDeCroock/pracht/pull/62) [`4017a4a`](https://github.com/JoviDeCroock/pracht/commit/4017a4a59ef702de14a3eb835b0d7bf0967509f8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve static assets directly from the Node adapter with proper Cache-Control headers. Hashed assets under /assets/ get immutable caching; HTML gets must-revalidate. Preview server now mirrors production caching behavior.

- [#51](https://github.com/JoviDeCroock/pracht/pull/51) [`db5f6d0`](https://github.com/JoviDeCroock/pracht/commit/db5f6d0a6770cd36fbcdaea708d2f161d2be23d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Apply default security headers to static asset responses across adapters

  Cloudflare static assets now inherit the same permissions-policy, referrer-policy, x-content-type-options, and x-frame-options headers that dynamic responses already receive. Vercel build output config now emits a headers section so static files served by Vercel's CDN also get the baseline security headers.

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [`c95bb72`](https://github.com/JoviDeCroock/pracht/commit/c95bb72c53a2d9012fde847139c276808ba5a9c3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix SSG prerendered pages missing client JS script tag and framework context

  Two issues caused prerendered (SSG) pages to ship without working hydration:

  1. **Vite 8 environment nesting**: The `@cloudflare/vite-plugin` outputs client assets
     to `<outDir>/client/`, so `outDir: "dist/client"` produced `dist/client/client/`.
     The CLI then couldn't find the Vite manifest, resulting in no `<script>` tag in
     prerendered HTML. Fixed by setting `outDir: "dist"`.

  2. **Dual Preact context copies**: The CLI imported `prerenderApp` from its own
     `@pracht/core`, while the server bundle had its own bundled copy. Different
     `createContext` instances meant `useLocation()` returned `/` during prerendering,
     breaking shell features like active link highlighting. Fixed by re-exporting
     `prerenderApp` from the server module so the CLI uses the same bundled copy.

- Updated dependencies [[`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308), [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc)]:
  - @pracht/core@0.0.1
