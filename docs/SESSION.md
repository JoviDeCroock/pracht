# Sessions

`@pracht/session` (`packages/session`) is the framework's session storage. It
exists because the documented auth pattern before it was hand-rolled in every
app: `btoa(JSON.stringify(session))` plus an HMAC, no expiry in the payload, a
`===` signature compare, no `Secure`, and a middleware that wrote `x-user-id`
onto the incoming request and trusted it downstream.

```bash
pnpm add @pracht/session
```

The public documentation lives at
`examples/docs/src/routes/docs/recipes-auth.md`
(<https://pracht.resynapse.dev/docs/recipes/auth>). This page is the
contributor's view: what the package is made of and why it is shaped the way
it is.

## Constraints

- **WebCrypto only.** `crypto.subtle` and `crypto.getRandomValues` are the
  entire platform surface, so one build runs on Node, Cloudflare Workers,
  Netlify, and Vercel. `packages/session/test/portability.test.ts` asserts
  this against both `src/` and the built `dist/index.mjs` — a `node:crypto`
  import would pass the unit tests and `pracht dev`, then fail at deploy time
  on Workers.
- **One workspace dependency**, `@pracht/core`, for `redirect()` and the
  middleware types.
- **No `this`, no class private fields.** The session object is parked on
  `context`, and adapters may hand application code a frozen context or an
  overlay proxy (see `skills/audit-auth/SKILL.md`). Every member is a closure.

## Modules

| File | Role |
| --- | --- |
| `src/crypto.ts` | HKDF-SHA256 key derivation, AES-256-GCM seal/open, base64url, `timingSafeEqual`, random ids |
| `src/cookie.ts` | Option validation, `Cookie` parsing, `Set-Cookie` serialization, the 4 KB guard |
| `src/session.ts` | `createSessionStorage()`, the `Session` object, `withSetCookie()` |
| `src/store.ts` | The `SessionStore` interface and `createMemorySessionStore()` |
| `src/middleware.ts` | `sessionMiddleware()` and `requireSession()` |
| `src/password.ts` | PBKDF2-HMAC-SHA256 `hashPassword()` / `verifyPassword()` |

## The cookie format

`v1.<base64url(iv ‖ ciphertext ‖ tag)>`, where the plaintext is a JSON
envelope:

```json
{ "n": "<cookie name>", "i": "<session id>", "e": 1767225600000, "d": { … }, "f": ["notice"] }
```

- **Encrypted, not merely signed.** A signed-but-readable cookie leaks its
  contents to anything that can read the cookie jar. `d` is present only for
  cookie sessions; store sessions keep the data server-side and the cookie
  carries just `i`.
- **`n` binds the payload to its cookie name**, compared with
  `timingSafeEqual`, so a value sealed for one cookie of an app cannot be
  replayed into another that shares the secret. This is the only
  non-cryptographic comparison in the package; every other integrity check is
  AES-GCM tag verification inside `crypto.subtle`, which is constant time by
  construction.
- **`e` is the real expiry.** `Max-Age` is a request the client is free to
  ignore.
- **Rotation has no key id.** `open()` tries every configured key, newest
  first. An id in the token would tell an attacker which secret to attack and
  buys nothing at the handful of secrets a rotation involves.

## Middleware shape

Both factories are wrap-around: they load the session before `next()` and
commit after it resolves. That is what lets a loader downstream call
`context.session.set(...)` and still have the cookie land on the response that
loader produced — nothing has to remember to commit. See
`packages/framework/src/runtime-middleware.ts` for the chain contract.

Three behaviours worth knowing before changing them:

- A response is committed only when `storage.isDirty(session)`. A read-only
  request emits no `Set-Cookie`.
- Responses get `Vary: Cookie`, **except** on `ssg`/`isg` routes: prerendered
  output is stored once and replayed, so it can depend on no request state,
  and `Vary: Cookie` would only fail `isCacheableISGResponse`. The same
  reasoning as the locale middleware in `packages/i18n/src/define.ts`.
- `requireSession()` distinguishes a page match from an API match by the
  presence of `middlewareFiles` on `args.route`, and answers a page with a
  redirect (which the client router follows on its route-state fetch) and an
  API route with `401`.

## Dogfood

`examples/basic` uses the package for its `auth` middleware, `/login` route,
and `/api/auth/{login,logout}` routes:

| File | |
| --- | --- |
| `src/server/session.ts` | Lazily built storage — `serverEnv` is request-scoped on Workers |
| `src/server/users.ts` | `hashPassword()`/`verifyPassword()` against a demo user |
| `src/middleware/auth.ts` | `requireSession(sessions(), { loginPath: "/login" })` |

`e2e/node-build.test.ts` logs in against the built Node server and fetches
`/dashboard` with the issued cookie, so the package is exercised end to end on
a real build rather than only in unit tests.

## Verifying a change

```bash
pnpm build
pnpm exec vitest run packages/session
pnpm exec playwright test e2e/node-build.test.ts --project=basic
```
