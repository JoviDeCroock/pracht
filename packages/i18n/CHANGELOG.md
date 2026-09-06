# @pracht/i18n

## 0.1.3

### Patch Changes

- [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add first-party sessions and pages-router parity for middleware, nested shells, capabilities, and agent configuration, while hardening request cancellation, client navigation, development responses, toolchain requirements, and scaffolded agent tooling. The authoring MCP command is now `pracht dev-mcp`, with `pracht mcp` retained as a deprecated alias.
- Updated dependencies [[`3a3148b`](https://github.com/JoviDeCroock/pracht/commit/3a3148b2662e62e0bdbf79b7aa170bf0996be4ce), [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b), [`cbe1f4d`](https://github.com/JoviDeCroock/pracht/commit/cbe1f4dd63e009cb73e748c0f8cd36f03b21a842), [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162), [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b), [`0b42d62`](https://github.com/JoviDeCroock/pracht/commit/0b42d622b55757eb73f19c3cff134ee42bfbcf18), [`6ae3d84`](https://github.com/JoviDeCroock/pracht/commit/6ae3d8425fe9760c77a9f9aafc91274bee052c13), [`1a0acb7`](https://github.com/JoviDeCroock/pracht/commit/1a0acb7d619df29bd99d5c8e13a5712fd909262e), [`6684cd8`](https://github.com/JoviDeCroock/pracht/commit/6684cd8356c9112ac933dd20e44464a231e7ad2f), [`27e6b80`](https://github.com/JoviDeCroock/pracht/commit/27e6b806ff1c28a6c2b0d9d94ca23361dea9696e), [`a269447`](https://github.com/JoviDeCroock/pracht/commit/a269447293b39d3bf3e23516318e0365c5ca8258), [`d0ab66e`](https://github.com/JoviDeCroock/pracht/commit/d0ab66ee65c7cb7a6a163f3220b6c668e40717ff)]:
  - @pracht/core@0.17.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`7ebedcb`](https://github.com/JoviDeCroock/pracht/commit/7ebedcbeb79bc216a6609642126ba00a46ef0f9a), [`c341eb4`](https://github.com/JoviDeCroock/pracht/commit/c341eb45703b70adfb18957e55faa5aa99969271), [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`cdffabc`](https://github.com/JoviDeCroock/pracht/commit/cdffabccdf8079cdbe57da2ecd7a11a0f22ad198), [`4ade033`](https://github.com/JoviDeCroock/pracht/commit/4ade03313c7f55b7b61ef3dcd2a9d2af6be188e1), [`32485f4`](https://github.com/JoviDeCroock/pracht/commit/32485f4f1a9199c0f073979fe6124b5159a1aa2b), [`a9bbf4a`](https://github.com/JoviDeCroock/pracht/commit/a9bbf4a6a03b16ca00d6655a340cc27b06b81dc6), [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175), [`2548140`](https://github.com/JoviDeCroock/pracht/commit/2548140ee82fd63e9e1264c042f6a3decd6f107f), [`40d6753`](https://github.com/JoviDeCroock/pracht/commit/40d675347c4725a618bb6e85d4fbe6c35d540cdc)]:
  - @pracht/core@0.16.0

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
