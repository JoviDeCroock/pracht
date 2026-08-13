---
"@pracht/i18n": minor
---

Support the prefix-free ("one URL per page") locale strategy, so an
existing site can adopt `@pracht/i18n` without changing any URLs.

Detection already worked without a URL prefix (cookie → `Accept-Language`),
but nothing could record an explicit choice: only a URL prefix persisted the
locale cookie. New primitives close that gap:

- `i18n.localeCookie(locale, { url?, secure? })` — serialize the locale
  cookie exactly as the middleware reads it (same name, `Path`, `Max-Age`,
  `SameSite`, `Secure` inferred from the request URL), for a switcher API
  route that sets the cookie and redirects back to the same URL. `null`
  clears it and returns to automatic detection. Unregistered locales throw
  rather than being reflected into a `Set-Cookie` header.

`SameSite=None` always forces `Secure`, including against an explicit false
override, so the browser accepts and persists the cookie.
- `i18n.setLocaleCookie(locale)` — the browser counterpart, writing through
  `document.cookie` so a client-side switch survives the next server render.
- `i18n.detectClient()` — browser-side `detect()`, resolving from
  `location.pathname`, `document.cookie`, and `navigator.languages` in the
  configured order. It returns the default locale during SSR instead of
  reading Node's global `navigator`, whose language is the server's.

Docs, the `add-i18n` skill, and `examples/basic` now present both
strategies: locale-prefixed URLs (better SEO, prerenderable) and one URL per
page (no URL changes, switch without navigating, at the cost of
`Vary: Cookie, Accept-Language` and no hreflang alternates). Both run
against a single `defineI18n` instance — the default detect order serves
either, since the path source simply never matches a prefix-free route.
