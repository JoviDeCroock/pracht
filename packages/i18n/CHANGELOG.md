# @pracht/i18n

## 0.1.1

### Patch Changes

- Updated dependencies [[`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069), [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6), [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2), [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f), [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd)]:
  - @pracht/core@0.15.0

## 0.1.0

### Minor Changes

- [#305](https://github.com/JoviDeCroock/pracht/pull/305) [`08afe0a`](https://github.com/JoviDeCroock/pracht/commit/08afe0aceebbcd8cc74e70a3439427a79c69a05b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - New `@pracht/i18n` package: first-party i18n primitives following the
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
  dictionary to the cookie and rendered locale state. Server-backed switches
  invalidate pending client imports before their POST begins, while loader-data
  changes invalidate them again during commit, so stale imports cannot overwrite
  the newer locale cookie on either side of the transition.
  
  Path-resolved SSR/SPA responses now vary on `Cookie` while conditional locale
  persistence can change `Set-Cookie`, preventing a shared cache from replaying
  a returning visitor's cookie-less response to a first-time visitor. Oversized
  `Accept-Language` headers discard a final entry cut by the defensive length
  limit instead of accidentally promoting it to quality 1. Prefix-free client
  switches also keep the localized document title aligned with the rendered
  messages and `<html lang>` value. The positive-entry cap continues scanning
  for later `q=0` exclusions, so a bounded header cannot hide an explicit locale
  rejection behind lower-value preferences.
  
  The reference prefix-free switch handler parses user-controlled return targets
  against the request URL and compares origins after normalization, so ASCII
  whitespace cannot turn an apparently root-relative path into an external
  redirect. The public recipe and `/add-i18n` skill use the same guarded pattern.

### Patch Changes

- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0
