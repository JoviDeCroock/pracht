# @pracht/i18n

## 0.1.7

### Patch Changes

- [#473](https://github.com/JoviDeCroock/pracht/pull/473) [`7547d11`](https://github.com/JoviDeCroock/pracht/commit/7547d111bfeb360f4b169ed3cd3945e8dca1bd75) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Locale detection now reads the URL prefix after the deploy base (`/my-project/nl/about` is `nl`), and `Accept-Language: zh-TW` or `zh-HK` now picks a registered `zh-Hant` locale over `zh-Hans`.

- [#485](https://github.com/JoviDeCroock/pracht/pull/485) [`aef4ef6`](https://github.com/JoviDeCroock/pracht/commit/aef4ef6cb9f70df2f2b2a51122e4fe7e66dfc88e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `@pracht/vite-plugin`, the adapters, `@pracht/session`, `@pracht/i18n`, `@pracht/query`, and `@pracht/test` now take `@pracht/core` as a peer dependency, so upgrading core no longer installs a second copy under them.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`2671f7c`](https://github.com/JoviDeCroock/pracht/commit/2671f7c2d58574ac2e38230721268fdaa790d6d8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The published JavaScript no longer carries doc comments, which shrinks an app's server bundle by about a third.
- Updated dependencies [[`2c015f9`](https://github.com/JoviDeCroock/pracht/commit/2c015f94fb9929a313ee21faaafb1927d56fc6d3), [`4e848b4`](https://github.com/JoviDeCroock/pracht/commit/4e848b4e115e3a3ff747df527e238453d7576ef9), [`3a9c0f1`](https://github.com/JoviDeCroock/pracht/commit/3a9c0f101e545ffb606498335f280d587d4099c6), [`40ca0af`](https://github.com/JoviDeCroock/pracht/commit/40ca0af4a8ae20f5994923cdd0298a2fdb8b19e7), [`75bb102`](https://github.com/JoviDeCroock/pracht/commit/75bb1021df4b445c81bf906b0b240085943280cb), [`253cbfd`](https://github.com/JoviDeCroock/pracht/commit/253cbfd8d15fb5bd73d4d34e9a1b38170a667a41), [`d37f96f`](https://github.com/JoviDeCroock/pracht/commit/d37f96ff52b54385f842479597ee5cc729384d5a), [`b54a359`](https://github.com/JoviDeCroock/pracht/commit/b54a359850b9ca8c7fc5deddd0880e8d1b253c7d), [`11fec33`](https://github.com/JoviDeCroock/pracht/commit/11fec33ca8656589d668c2bed87ece51394ed344), [`9c5d4fc`](https://github.com/JoviDeCroock/pracht/commit/9c5d4fc0c789928c70b091484045a90f312127f5), [`d2d3563`](https://github.com/JoviDeCroock/pracht/commit/d2d3563e5bac4fb645771245bf5a56f1f324c275), [`327403e`](https://github.com/JoviDeCroock/pracht/commit/327403ea7d64beb3d9d4fdaa309cc4b8eace9476), [`5be49ed`](https://github.com/JoviDeCroock/pracht/commit/5be49ed863529fc5ddc0650600d8ced973308d32), [`101f18c`](https://github.com/JoviDeCroock/pracht/commit/101f18c597e7e3881b503fcce031b21e7a270720), [`a67e842`](https://github.com/JoviDeCroock/pracht/commit/a67e842e7fbaa594d1cca74bfc134864aa5d49e2), [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374), [`85c3372`](https://github.com/JoviDeCroock/pracht/commit/85c3372fb48597acb2fb6f958a66f73b97d2b2fd), [`3d1cf12`](https://github.com/JoviDeCroock/pracht/commit/3d1cf12e47e1899b8a1a7026b6582b761a62ca82), [`f44125f`](https://github.com/JoviDeCroock/pracht/commit/f44125f9401742f06da41f6fb208d6b33051d8d2), [`32a4b15`](https://github.com/JoviDeCroock/pracht/commit/32a4b1592155d83a941034a303f5c11e76d77fd5), [`0d19bfe`](https://github.com/JoviDeCroock/pracht/commit/0d19bfebe1335149418ebf56c965af03c1e1d56f), [`417cda3`](https://github.com/JoviDeCroock/pracht/commit/417cda383a53f9a8de7747640e32481ece543378), [`2c3a4fc`](https://github.com/JoviDeCroock/pracht/commit/2c3a4fc685931a1e0f201ab332d3376da0d110a2), [`e4a0f20`](https://github.com/JoviDeCroock/pracht/commit/e4a0f2056f540cb8f7c92503e0aaded0ad612311), [`d2f2ca7`](https://github.com/JoviDeCroock/pracht/commit/d2f2ca77ae2c897e02790625d278f0600002c274), [`4324c2c`](https://github.com/JoviDeCroock/pracht/commit/4324c2cdac89fbc752cabbcf377a87f10159675a), [`de917e3`](https://github.com/JoviDeCroock/pracht/commit/de917e3d010d433051102d730440fd45ad702ecf), [`e0d0b72`](https://github.com/JoviDeCroock/pracht/commit/e0d0b72e95bd526f50c900670348449c0c00e74e), [`67e52f0`](https://github.com/JoviDeCroock/pracht/commit/67e52f01fbf49d063cbf521d6ca1e1c7b96f3664), [`1bc5c0c`](https://github.com/JoviDeCroock/pracht/commit/1bc5c0cc4c867430b2ffa59c98f396511724cf57), [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374), [`fa78a31`](https://github.com/JoviDeCroock/pracht/commit/fa78a31aa5a4f71211d13faad038d5f81ebdf0be), [`f2bc804`](https://github.com/JoviDeCroock/pracht/commit/f2bc804c73a90eff263ed15871253f3582edce03), [`b435ddf`](https://github.com/JoviDeCroock/pracht/commit/b435ddfdc5fe608dc067b7d359090854a3ec4ba6), [`39eb55d`](https://github.com/JoviDeCroock/pracht/commit/39eb55de708b1fe03c361c6417bcfe8494bc83d2), [`84d0580`](https://github.com/JoviDeCroock/pracht/commit/84d0580529f0672e207a03fe55ec4f6a08d14ff8), [`6e1e268`](https://github.com/JoviDeCroock/pracht/commit/6e1e2685b10a78deb2473c7630a31f82268e897d), [`af2332f`](https://github.com/JoviDeCroock/pracht/commit/af2332f8105be18029cc18239a3b5a80e40dda45), [`7d3286c`](https://github.com/JoviDeCroock/pracht/commit/7d3286cf148cb63e82bf4defe7df370f9bf7e164), [`1d0754b`](https://github.com/JoviDeCroock/pracht/commit/1d0754b577ecbcbc84f759c5fffface4f6703aac), [`2671f7c`](https://github.com/JoviDeCroock/pracht/commit/2671f7c2d58574ac2e38230721268fdaa790d6d8), [`e0b48fb`](https://github.com/JoviDeCroock/pracht/commit/e0b48fb38f549548d14c90dd65f84dca2b86a51b), [`2f17ca5`](https://github.com/JoviDeCroock/pracht/commit/2f17ca565b8ed8d4d581e8490aaa98fb189b1d6d), [`59396a5`](https://github.com/JoviDeCroock/pracht/commit/59396a56109c0fcbcfe49821f3bb2c3b98f07a63), [`9007173`](https://github.com/JoviDeCroock/pracht/commit/9007173fe03fb6bd4312ae14fcd07365131716c6), [`25be9ab`](https://github.com/JoviDeCroock/pracht/commit/25be9ab4da435992d063fcb85c3df72ea9a36c88), [`ed90679`](https://github.com/JoviDeCroock/pracht/commit/ed9067934c91e9e4f1a1fd0a925b8d7e97cffda7), [`9bc84fa`](https://github.com/JoviDeCroock/pracht/commit/9bc84fa7c3dce065c89692afd263f16afaaef55e)]:
  - @pracht/core@0.21.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`4ad18d6`](https://github.com/JoviDeCroock/pracht/commit/4ad18d69b3503b8aae27605b548ecaa01d0d5619)]:
  - @pracht/core@0.20.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`769929a`](https://github.com/JoviDeCroock/pracht/commit/769929a6656956b6cf94796465340879884131f2), [`5091b83`](https://github.com/JoviDeCroock/pracht/commit/5091b83ffced8785654b742fbd63932b40ddbb58), [`be5203c`](https://github.com/JoviDeCroock/pracht/commit/be5203c03cb2d65a30bbd9874430f08b9b3483ca), [`5fa4ef2`](https://github.com/JoviDeCroock/pracht/commit/5fa4ef2a4e47e1a2bbb3c1f570c3e9dd0467345a), [`82cd57f`](https://github.com/JoviDeCroock/pracht/commit/82cd57f3e2d6fc2e4305353dc7f9f128cc069ba4), [`0dc51e0`](https://github.com/JoviDeCroock/pracht/commit/0dc51e0b62c766d771aaba1eaa962f5d28e5c950), [`a33c6ef`](https://github.com/JoviDeCroock/pracht/commit/a33c6efabd89a3dca622ab00123e32038fc37f28), [`5affc0a`](https://github.com/JoviDeCroock/pracht/commit/5affc0adc916c5612a9749b939809aaebacfd7e7), [`10807de`](https://github.com/JoviDeCroock/pracht/commit/10807deae449423aeeaffa773f5ed519a6d85831), [`6038d57`](https://github.com/JoviDeCroock/pracht/commit/6038d57e508712b33a08a072d0ea8e72f3996d6e), [`09543a9`](https://github.com/JoviDeCroock/pracht/commit/09543a91385f55fe8db0cdf20fd9b3d8438e6839), [`d0e8bac`](https://github.com/JoviDeCroock/pracht/commit/d0e8bac992e1abe8562dfe77aa930f901b7b9bf0), [`f3f0234`](https://github.com/JoviDeCroock/pracht/commit/f3f0234bbd3b928ae682a4dbe4610d6b7cca6748), [`8309084`](https://github.com/JoviDeCroock/pracht/commit/830908420b91ac8691fd0335ec449f20ca520680)]:
  - @pracht/core@0.19.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`b42f586`](https://github.com/JoviDeCroock/pracht/commit/b42f5864f2c24935c4b5a43bbb7fd75545dfc079), [`69f1b07`](https://github.com/JoviDeCroock/pracht/commit/69f1b0787de81cc08c7b55a3b10bd0e0ed6bc782), [`3b44c60`](https://github.com/JoviDeCroock/pracht/commit/3b44c600911f7ea734c22e494372376f68611c4f)]:
  - @pracht/core@0.18.0

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
