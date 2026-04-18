# create-pracht

## 0.2.2

### Patch Changes

- [#131](https://github.com/JoviDeCroock/pracht/pull/131) [`015e987`](https://github.com/JoviDeCroock/pracht/commit/015e987a2de471980fab557e3dbf3d52937ad0ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Security hardening across request handling, redirects, and build output.

  **Framework (`@pracht/core`)**

  - **Middleware/loader redirects are now validated.** `javascript:`, `data:`,
    `vbscript:`, `blob:`, and `file:` targets are refused server-side (they
    were already refused on the client) and CR/LF in the `Location` value
    throws instead of producing a split response. Non-safe-method redirects
    now default to **303 See Other** rather than 302 so browsers don't
    resend the POST body to the redirect target. `MiddlewareResult`'s
    `redirect` form now accepts an optional `status` override.
  - **CSRF protection for mutating API routes.** Non-GET API requests are
    rejected with 403 unless the browser signals a same-origin/same-site
    fetch (`Sec-Fetch-Site`) or the `Origin` header matches the request
    URL's origin. Opt out per-app via `defineApp({ api: { requireSameOrigin: false } })`.
  - **`_data=1` route-state bypass is now gated.** The query-param form of
    the route-state endpoint now requires `Sec-Fetch-Site: same-origin`/
    `same-site` (or a matching `Origin`). The explicit
    `x-pracht-route-state-request` header is still accepted unconditionally
    (CORS-protected).
  - **Catch-all path traversal at build time is closed.**
    `buildPathFromSegments` now percent-encodes catch-all components
    individually and explicitly neutralises `.` / `..` segments, so a
    `getStaticPaths` returning `{ "*": "../../etc/passwd" }` can no longer
    escape `dist/client/` at SSG/ISG write time.
  - **`headers()` values are validated for CR/LF.** `applyHeaders` now
    throws a consistent framework error on response-splitting attempts,
    regardless of adapter-specific Headers implementation behaviour.
  - **`debugErrors` is ignored in production.** When `NODE_ENV=production`,
    `debugErrors: true` is refused (with a one-shot console warning) so a
    misconfigured deploy cannot leak stack traces and module paths.

  **Adapter (`@pracht/adapter-node`)**

  - **Symlinks are no longer followed by the static server.** `resolveStaticFile`
    now uses `lstat` and rejects files whose inode is a symlink, preventing
    a malicious build artifact from exposing files outside `dist/client/`.
  - **ISG cache is path-contained.** The on-disk write path is now
    `resolve()`-checked against the static root, rejecting any URL path
    that would escape via `..`, encoded separators, or NUL bytes.
  - **ISG skips the on-disk cache when the response is user-specific.**
    Responses that set `Cache-Control: no-store`/`private`, `Set-Cookie`,
    or a `Vary` covering `cookie`/`authorization`/`*` are served through
    but not written to disk, closing a per-user cache-poisoning window.

  **Packaging**

  - `@pracht/cli` now has an explicit `files` allowlist so future
    workdir additions can't accidentally ship in the npm tarball.
  - `create-pracht`'s bin entry is now executable in the repository.

## 0.2.1

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

## 0.2.0

### Minor Changes

- [#68](https://github.com/JoviDeCroock/pracht/pull/68) [`359af55`](https://github.com/JoviDeCroock/pracht/commit/359af5506dd6b3baf76d4020471275d95b445302) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Generate AGENTS.md and CLAUDE.md symlink in scaffolded projects describing project structure, commands, and scaffolding CLI usage

- [#66](https://github.com/JoviDeCroock/pracht/pull/66) [`c27ab9a`](https://github.com/JoviDeCroock/pracht/commit/c27ab9a3cfaa8706c9fb6f43de45511a12a7e524) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add non-interactive machine mode to create-pracht. New flags: `--yes`/`-y` (accept defaults, skip prompts), `--json` (JSON summary output), `--dry-run` (list files without writing). Invalid adapter or router values now exit with code 2.

### Patch Changes

- [#48](https://github.com/JoviDeCroock/pracht/pull/48) [`4520c16`](https://github.com/JoviDeCroock/pracht/commit/4520c168286e1c2716b49a4d744cc60fa9b25195) Thanks [@barelyhuman](https://github.com/barelyhuman)! - adds a tsconfig.json in the adapter starters

## 0.1.0

### Minor Changes

- [#25](https://github.com/JoviDeCroock/pracht/pull/25) [`f0ea0fb`](https://github.com/JoviDeCroock/pracht/commit/f0ea0fb0702fc65b2b68b63a4af2d722f11c2b60) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add router prompt to create-pracht CLI asking whether to use pages-router (file-system routing) or manifest (explicit routes.ts). Supports `--router=manifest|pages` flag.

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#22](https://github.com/JoviDeCroock/pracht/pull/22) [`e62e082`](https://github.com/JoviDeCroock/pracht/commit/e62e08293ba7a52c0d52437db37f5fd5db646252) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Resolve actual latest versions from the npm registry instead of inserting "latest" in scaffolded package.json
