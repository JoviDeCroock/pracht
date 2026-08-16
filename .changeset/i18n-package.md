---
"@pracht/i18n": minor
---

New `@pracht/i18n` package: first-party i18n primitives following the
framework's documented pattern (middleware detects the locale, loaders
return translations, components consume them via route data).

- `defineI18n({ locales, defaultLocale, detect?, cookie? })` — locale
  registry with detection middleware (URL prefix → cookie →
  `Accept-Language` q-values, configurable order) that sets
  `context.locale` and persists explicit URL-prefix choices in a
  `SameSite=Lax` cookie, plus `localePath()`, `splitLocale()`,
  `isLocale()`, `detect()`, and an `hreflang()` helper producing `link[]`
  alternate entries for `head()`.
- `createDictionaries()` — lazy per-locale dictionary loading with typed
  keys derived from the default locale's shape; loaded messages are plain
  serializable objects merged over the default locale. Dictionary key types
  match runtime sanitization, including special own flat keys such as
  `__proto__`, without invoking object prototype behavior.
- `t()` / `tPlural()` — `{param}` interpolation (single-pass, injection
  safe) and plural selection via `Intl.PluralRules` with `.other`
  fallback.
- Prefix-free locale switching through `localeCookie()`,
  `setLocaleCookie()`, and `detectClient()`, allowing sites to keep one URL
  per page while persisting an explicit client choice. Cookie serialization
  shares the middleware configuration, rejects unregistered locales, and can
  clear the choice to restore automatic detection.

Only registered locales can win detection; malformed `Accept-Language`
q-values and duplicate quality parameters are rejected, explicit `q=0`
exclusions remain excluded through lookup and best-fit fallbacks, wildcard
fallbacks cannot revive excluded locales, conflicting scripts do not use a
same-language best fit, and directly matched registered variants are preferred.
Every locale accepted by `defineI18n()` remains detectable regardless of tag
length. Unregistered URL/cookie/wildcard locales are ignored, and
`localePath()` throws rather than reflecting unknown locales into URLs. It
resolves literal and percent-encoded dot segments before prefixing, so browser
URL normalization cannot escape the selected locale namespace.

`SameSite=None` locale cookies always include `Secure`, even if configuration
tries to disable it, so browsers do not silently reject locale persistence.

Caching-correctness guarantees: cookie persistence is skipped on
prerenderable (SSG/ISG) routes, so locale-prefixed routes can prerender
without a `Set-Cookie` failing the build or blocking ISG revalidation;
hydration still remembers an explicit locale without adding a visitor-specific
header to shared output;
the middleware appends `Vary: Cookie` / `Accept-Language` for consulted
detection sources so shared caches key correctly; and `Accept-Language`
matching follows RFC 4647 lookup (progressive truncation,
`zh-Hant-TW` → `zh-Hant`) with a same-language best fit
(`en-GB` → registered `en-US`).

Locale-stripped paths stay root-relative through duplicate-slash and URL
normalization edge cases. Generated hreflang entries preserve query/hash
suffixes on the default `x-default` target. The documented asynchronous
prefix-free client switch commits only the latest successfully loaded
dictionary to the cookie and rendered locale state, and a loader-data change
invalidates pending switches during commit before stale imports can resume.

Path-resolved SSR/SPA responses now vary on `Cookie` while conditional locale
persistence can change `Set-Cookie`, preventing a shared cache from replaying
a returning visitor's cookie-less response to a first-time visitor. Oversized
`Accept-Language` headers discard a final entry cut by the defensive length
limit instead of accidentally promoting it to quality 1. Prefix-free client
switches also keep the localized document title aligned with the rendered
messages and `<html lang>` value.
