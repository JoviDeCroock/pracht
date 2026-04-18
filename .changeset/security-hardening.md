---
"@pracht/core": minor
"@pracht/adapter-node": patch
"@pracht/cli": patch
"create-pracht": patch
---

Security hardening across request handling, redirects, and build output.

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
