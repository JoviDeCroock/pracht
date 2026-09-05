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
| `src/password.ts` | PBKDF2-HMAC-SHA256 `hashPassword()` / `verifyPassword()`, with one iteration floor enforced on both paths |

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
- **Base64url must be canonical.** `atob` drops the unused low bits of the
  final character, so several strings decode to identical bytes;
  `fromBase64Url` re-encodes and compares, which keeps the token string a
  stable identifier for the session it opens.
- **The cookie is read as a list, not a value.** A cookie is identified by
  name *plus* domain and path, so a request may legitimately carry two of the
  same name — host-only and parent-domain — in an order the server cannot rely
  on. `readCookies()` returns every candidate and `readEnvelope()` takes the
  first that unseals *and* validates, so a junk duplicate does not take
  precedence over the real session.

  This is a robustness measure, **not** a defence against an attacker who can
  write cookies for the host. The candidate list is capped at 8
  (`MAX_COOKIE_CANDIDATES`, `src/cookie.ts`) because the loop costs one
  AES-GCM open per candidate per secret, and RFC 6265 sends longer-`Path`
  cookies first — so someone able to set host cookies can plant nine at a
  deeper path and push the real one past the cap, denying the session. The cap
  bounds the work; it does not guarantee the real cookie is reached.

  The actual mitigation is the `__Host-` prefix, which is why it is the
  default. It pins the cookie host-only and `Path=/`, which are exactly the
  two fields that distinguish same-name cookies — so at most one
  `__Host-session` can exist, and a sibling subdomain cannot write one at all.
  An app that opts out of the prefix (to share a cookie across subdomains)
  accepts the duplicate-flooding case above.

## Two things the shape of the cookie decides

**Session fixation** is a store-mode problem only. With a store the cookie is
a pointer, so an attacker who can write a cookie for the host plants an id,
waits for login, and their copy addresses the now-authenticated record.
`Session.regenerate()` mints a new id, keeps the data, and deletes the old
record; the login path calls it before writing the user. Cookie mode carries
the sealed data rather than a pointer, so a replayed cookie decrypts to the
anonymous session it was sealed with — `regenerate()` is a no-op for security
there and is still called so the path is correct if a store is added later.

**`Secure` fails closed.** Inferring it from `request.url` being https is
wrong behind a TLS-terminating proxy: `@pracht/adapter-node` defaults to
`trustProxy: false`, so a production request reads as `http://` and the
attribute would be dropped on exactly the deployments that need it. The
attribute is set unless `isLocalHttpRequest()` recognises plain http from
`localhost`/`*.localhost`/`127.0.0.1`/`[::1]`. `__Host-`/`__Secure-` names and
`sameSite: "None"` pin it on and refuse an explicit `secure: false` rather
than silently overriding it.

## Expiry

Absolute from the last write: `maxAge` counts from the most recent
`commitSession()`, and `sessionMiddleware()` commits only when
`storage.isDirty(session)`. `rolling: true` makes `isDirty()` also true for
any session that was loaded or committed, so every request re-seals and
`maxAge` becomes an idle timeout — at the price of a `Set-Cookie` per response
and, with a store, a write per request. It never fires for a session that does
not exist yet, so anonymous traffic still receives no cookie.

`rolling` interacts with prerendered routes. `varyOnCookie()` withholds
`Vary: Cookie` from `ssg`/`isg` responses, but the commit itself is not
withheld, and `isCacheableISGResponse()`
(`packages/framework/src/revalidation.ts`) rejects any response carrying a
`Set-Cookie`. So a route group that mixes `rolling` with prerendered routes
serves them uncached to every signed-in visitor. That is the right answer —
the alternative is replaying one visitor's `Set-Cookie` to the next — but it
is silent, so the recipe tells apps to scope `rolling` to the `ssr` group.

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
