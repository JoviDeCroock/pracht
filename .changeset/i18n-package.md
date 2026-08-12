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
  serializable objects merged over the default locale.
- `t()` / `tPlural()` — `{param}` interpolation (single-pass, injection
  safe) and plural selection via `Intl.PluralRules` with `.other`
  fallback.

Only registered locales can win detection; malformed `Accept-Language`
q-values are dropped, unregistered URL/cookie locales are ignored, and
`localePath()` throws rather than reflecting unknown locales into URLs.
