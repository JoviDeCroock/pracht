# @pracht/vite-plugin

## 0.1.4

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix production asset metadata wiring so built SSR and prerendered pages use hashed client entries and modulepreload hints consistently.

- [#87](https://github.com/JoviDeCroock/pracht/pull/87) [`2170fc5`](https://github.com/JoviDeCroock/pracht/commit/2170fc5e0f29de57a47954e0b5d19427d807b728) Thanks [@kinngh](https://github.com/kinngh)! - Allow dev SSR page routes to handle dotted query strings by checking only the URL pathname before handing static assets to Vite.

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3
  - @pracht/adapter-cloudflare@0.0.6
  - @pracht/adapter-vercel@0.0.6

## 0.1.3

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2
  - @pracht/adapter-cloudflare@0.0.5
  - @pracht/adapter-vercel@0.0.5

## 0.1.2

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1
  - @pracht/adapter-cloudflare@0.0.4
  - @pracht/adapter-vercel@0.0.4

## 0.1.1

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0
  - @pracht/adapter-cloudflare@0.0.3
  - @pracht/adapter-vercel@0.0.3

## 0.1.0

### Minor Changes

- [#12](https://github.com/JoviDeCroock/pracht/pull/12) [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support `() => import("./path")` syntax in route manifests for IDE click-to-navigate

### Patch Changes

- [#59](https://github.com/JoviDeCroock/pracht/pull/59) [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Sanitize unexpected 5xx route errors by default in SSR HTML, route-state JSON,
  and hydration payloads while preserving explicit `PrachtHttpError` 4xx
  messages. Add an explicitly opt-in `debugErrors` escape hatch for local
  debugging and ensure the Vite dev server keeps verbose errors enabled only
  through that option.

- [#67](https://github.com/JoviDeCroock/pracht/pull/67) [`b052965`](https://github.com/JoviDeCroock/pracht/commit/b052965d5f87dd60fc037e3929511cb3fc589f3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add trusted proxy aware request URL construction

  The Node adapter now defaults to deriving the request URL from the socket
  (TLS state for protocol, Host header for host) instead of blindly trusting
  X-Forwarded-Proto. A new `trustProxy` option opts into honoring forwarded
  headers (Forwarded RFC 7239, X-Forwarded-Proto, X-Forwarded-Host) when
  the server sits behind a trusted reverse proxy.

  The dev SSR middleware no longer reads X-Forwarded-Proto at all, preventing
  host-header poisoning during development.

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`db5f6d0`](https://github.com/JoviDeCroock/pracht/commit/db5f6d0a6770cd36fbcdaea708d2f161d2be23d3), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0
  - @pracht/adapter-cloudflare@0.0.2
  - @pracht/adapter-vercel@0.0.2

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option

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
  - @pracht/adapter-cloudflare@0.0.1
  - @pracht/adapter-vercel@0.0.1
