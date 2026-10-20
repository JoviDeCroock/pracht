# @pracht/adapter-vercel

## 0.4.2

### Patch Changes

- [#496](https://github.com/JoviDeCroock/pracht/pull/496) [`1a78533`](https://github.com/JoviDeCroock/pracht/commit/1a7853392094628de1a3546ee5616aa3552d1c4b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Adapters can write their platform's deploy output from a new `finalizeBuild(context)` hook that `pracht build` calls after prerendering, and a plain `vite build` now fails with a pointer to `pracht build` instead of an unresolved `index.html`.

- [#446](https://github.com/JoviDeCroock/pracht/pull/446) [`84f9d40`](https://github.com/JoviDeCroock/pracht/commit/84f9d40b74b9656c988fec6e2081e7c90eaf6782) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Each adapter now exports the `PrachtAdapter` type its factory returns, so that return type no longer resolves to `any` under strict installs such as Yarn PnP or pnpm's global virtual store.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`11fec33`](https://github.com/JoviDeCroock/pracht/commit/11fec33ca8656589d668c2bed87ece51394ed344) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The adapter contract (`PrachtAdapter` and its build and dev types) is now importable from `@pracht/core/adapter`, and `createServerEntryModule(entry)` receives the build's `buildId`; `@pracht/vite-plugin` keeps re-exporting the same types.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`101f18c`](https://github.com/JoviDeCroock/pracht/commit/101f18c597e7e3881b503fcce031b21e7a270720) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - An ISG page requested, revalidated, or declared in `routes.ts` with lower-case percent-escapes (`/posts/caf%c3%a9`) now uses the same snapshot as its upper-case URL.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`a67e842`](https://github.com/JoviDeCroock/pracht/commit/a67e842e7fbaa594d1cca74bfc134864aa5d49e2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Regenerated ISG pages now keep the same document headers on every adapter, and Cloudflare now strips credential-shaped headers from them like Node, Vercel and Netlify do.

- [#455](https://github.com/JoviDeCroock/pracht/pull/455) [`1bc5c0c`](https://github.com/JoviDeCroock/pracht/commit/1bc5c0cc4c867430b2ffa59c98f396511724cf57) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The `/__pracht/revalidate` response includes a `scope` field, `instance`, `colo`, or `global`, saying how far each revalidation reached.

- [#485](https://github.com/JoviDeCroock/pracht/pull/485) [`aef4ef6`](https://github.com/JoviDeCroock/pracht/commit/aef4ef6cb9f70df2f2b2a51122e4fe7e66dfc88e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `@pracht/vite-plugin`, the adapters, `@pracht/session`, `@pracht/i18n`, `@pracht/query`, and `@pracht/test` now take `@pracht/core` as a peer dependency, so upgrading core no longer installs a second copy under them.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`2671f7c`](https://github.com/JoviDeCroock/pracht/commit/2671f7c2d58574ac2e38230721268fdaa790d6d8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The published JavaScript no longer carries doc comments, which shrinks an app's server bundle by about a third.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - An ISG render that sets a cookie or marks itself private is no longer stored in Vercel's prerender cache: the function answers `503` and visitors keep the previous page.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`1c29361`](https://github.com/JoviDeCroock/pracht/commit/1c2936103a91d6c74ab54ebb67e3a5dc2e0729c7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Vercel ISG functions stream their response to the client instead of buffering it whole.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`589c62a`](https://github.com/JoviDeCroock/pracht/commit/589c62a2ac5bcb821ba3278c5af2b09dc0cca1a2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The ISG Node function waits for the client to drain large bodies and stops streaming when the client disconnects.
- Updated dependencies [[`2c015f9`](https://github.com/JoviDeCroock/pracht/commit/2c015f94fb9929a313ee21faaafb1927d56fc6d3), [`4e848b4`](https://github.com/JoviDeCroock/pracht/commit/4e848b4e115e3a3ff747df527e238453d7576ef9), [`3a9c0f1`](https://github.com/JoviDeCroock/pracht/commit/3a9c0f101e545ffb606498335f280d587d4099c6), [`75bb102`](https://github.com/JoviDeCroock/pracht/commit/75bb1021df4b445c81bf906b0b240085943280cb), [`253cbfd`](https://github.com/JoviDeCroock/pracht/commit/253cbfd8d15fb5bd73d4d34e9a1b38170a667a41), [`d37f96f`](https://github.com/JoviDeCroock/pracht/commit/d37f96ff52b54385f842479597ee5cc729384d5a), [`b54a359`](https://github.com/JoviDeCroock/pracht/commit/b54a359850b9ca8c7fc5deddd0880e8d1b253c7d), [`11fec33`](https://github.com/JoviDeCroock/pracht/commit/11fec33ca8656589d668c2bed87ece51394ed344), [`9c5d4fc`](https://github.com/JoviDeCroock/pracht/commit/9c5d4fc0c789928c70b091484045a90f312127f5), [`d2d3563`](https://github.com/JoviDeCroock/pracht/commit/d2d3563e5bac4fb645771245bf5a56f1f324c275), [`327403e`](https://github.com/JoviDeCroock/pracht/commit/327403ea7d64beb3d9d4fdaa309cc4b8eace9476), [`5be49ed`](https://github.com/JoviDeCroock/pracht/commit/5be49ed863529fc5ddc0650600d8ced973308d32), [`101f18c`](https://github.com/JoviDeCroock/pracht/commit/101f18c597e7e3881b503fcce031b21e7a270720), [`a67e842`](https://github.com/JoviDeCroock/pracht/commit/a67e842e7fbaa594d1cca74bfc134864aa5d49e2), [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374), [`85c3372`](https://github.com/JoviDeCroock/pracht/commit/85c3372fb48597acb2fb6f958a66f73b97d2b2fd), [`f44125f`](https://github.com/JoviDeCroock/pracht/commit/f44125f9401742f06da41f6fb208d6b33051d8d2), [`32a4b15`](https://github.com/JoviDeCroock/pracht/commit/32a4b1592155d83a941034a303f5c11e76d77fd5), [`0d19bfe`](https://github.com/JoviDeCroock/pracht/commit/0d19bfebe1335149418ebf56c965af03c1e1d56f), [`417cda3`](https://github.com/JoviDeCroock/pracht/commit/417cda383a53f9a8de7747640e32481ece543378), [`2c3a4fc`](https://github.com/JoviDeCroock/pracht/commit/2c3a4fc685931a1e0f201ab332d3376da0d110a2), [`e4a0f20`](https://github.com/JoviDeCroock/pracht/commit/e4a0f2056f540cb8f7c92503e0aaded0ad612311), [`d2f2ca7`](https://github.com/JoviDeCroock/pracht/commit/d2f2ca77ae2c897e02790625d278f0600002c274), [`4324c2c`](https://github.com/JoviDeCroock/pracht/commit/4324c2cdac89fbc752cabbcf377a87f10159675a), [`de917e3`](https://github.com/JoviDeCroock/pracht/commit/de917e3d010d433051102d730440fd45ad702ecf), [`e0d0b72`](https://github.com/JoviDeCroock/pracht/commit/e0d0b72e95bd526f50c900670348449c0c00e74e), [`67e52f0`](https://github.com/JoviDeCroock/pracht/commit/67e52f01fbf49d063cbf521d6ca1e1c7b96f3664), [`1bc5c0c`](https://github.com/JoviDeCroock/pracht/commit/1bc5c0cc4c867430b2ffa59c98f396511724cf57), [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374), [`fa78a31`](https://github.com/JoviDeCroock/pracht/commit/fa78a31aa5a4f71211d13faad038d5f81ebdf0be), [`f2bc804`](https://github.com/JoviDeCroock/pracht/commit/f2bc804c73a90eff263ed15871253f3582edce03), [`b435ddf`](https://github.com/JoviDeCroock/pracht/commit/b435ddfdc5fe608dc067b7d359090854a3ec4ba6), [`39eb55d`](https://github.com/JoviDeCroock/pracht/commit/39eb55de708b1fe03c361c6417bcfe8494bc83d2), [`84d0580`](https://github.com/JoviDeCroock/pracht/commit/84d0580529f0672e207a03fe55ec4f6a08d14ff8), [`6e1e268`](https://github.com/JoviDeCroock/pracht/commit/6e1e2685b10a78deb2473c7630a31f82268e897d), [`af2332f`](https://github.com/JoviDeCroock/pracht/commit/af2332f8105be18029cc18239a3b5a80e40dda45), [`7d3286c`](https://github.com/JoviDeCroock/pracht/commit/7d3286cf148cb63e82bf4defe7df370f9bf7e164), [`1d0754b`](https://github.com/JoviDeCroock/pracht/commit/1d0754b577ecbcbc84f759c5fffface4f6703aac), [`2671f7c`](https://github.com/JoviDeCroock/pracht/commit/2671f7c2d58574ac2e38230721268fdaa790d6d8), [`e0b48fb`](https://github.com/JoviDeCroock/pracht/commit/e0b48fb38f549548d14c90dd65f84dca2b86a51b), [`2f17ca5`](https://github.com/JoviDeCroock/pracht/commit/2f17ca565b8ed8d4d581e8490aaa98fb189b1d6d), [`59396a5`](https://github.com/JoviDeCroock/pracht/commit/59396a56109c0fcbcfe49821f3bb2c3b98f07a63), [`9007173`](https://github.com/JoviDeCroock/pracht/commit/9007173fe03fb6bd4312ae14fcd07365131716c6), [`25be9ab`](https://github.com/JoviDeCroock/pracht/commit/25be9ab4da435992d063fcb85c3df72ea9a36c88), [`ed90679`](https://github.com/JoviDeCroock/pracht/commit/ed9067934c91e9e4f1a1fd0a925b8d7e97cffda7), [`9bc84fa`](https://github.com/JoviDeCroock/pracht/commit/9bc84fa7c3dce065c89692afd263f16afaaef55e)]:
  - @pracht/core@0.21.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`4ad18d6`](https://github.com/JoviDeCroock/pracht/commit/4ad18d69b3503b8aae27605b548ecaa01d0d5619)]:
  - @pracht/core@0.20.0

## 0.4.0

### Minor Changes

- [#417](https://github.com/JoviDeCroock/pracht/pull/417) [`5affc0a`](https://github.com/JoviDeCroock/pracht/commit/5affc0adc916c5612a9749b939809aaebacfd7e7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Loaders, middleware, API routes, `head()`/`headers()`, and capability `run()` now receive `waitUntil(promise)`, which keeps work running after the response on every adapter. Migration: code that builds these args by hand must pass `waitUntil` (for example `waitUntil: () => {}`).

### Patch Changes

- [`1f61f1e`](https://github.com/JoviDeCroock/pracht/commit/1f61f1efeb97de608d2c195b12826e6d27467492) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht dev` now builds `args.context` with the adapter's `createContextFrom` factory, so loaders, middleware, and API routes see the same context in development as in production.
- Updated dependencies [[`769929a`](https://github.com/JoviDeCroock/pracht/commit/769929a6656956b6cf94796465340879884131f2), [`5091b83`](https://github.com/JoviDeCroock/pracht/commit/5091b83ffced8785654b742fbd63932b40ddbb58), [`be5203c`](https://github.com/JoviDeCroock/pracht/commit/be5203c03cb2d65a30bbd9874430f08b9b3483ca), [`5fa4ef2`](https://github.com/JoviDeCroock/pracht/commit/5fa4ef2a4e47e1a2bbb3c1f570c3e9dd0467345a), [`82cd57f`](https://github.com/JoviDeCroock/pracht/commit/82cd57f3e2d6fc2e4305353dc7f9f128cc069ba4), [`0dc51e0`](https://github.com/JoviDeCroock/pracht/commit/0dc51e0b62c766d771aaba1eaa962f5d28e5c950), [`a33c6ef`](https://github.com/JoviDeCroock/pracht/commit/a33c6efabd89a3dca622ab00123e32038fc37f28), [`5affc0a`](https://github.com/JoviDeCroock/pracht/commit/5affc0adc916c5612a9749b939809aaebacfd7e7), [`10807de`](https://github.com/JoviDeCroock/pracht/commit/10807deae449423aeeaffa773f5ed519a6d85831), [`6038d57`](https://github.com/JoviDeCroock/pracht/commit/6038d57e508712b33a08a072d0ea8e72f3996d6e), [`09543a9`](https://github.com/JoviDeCroock/pracht/commit/09543a91385f55fe8db0cdf20fd9b3d8438e6839), [`d0e8bac`](https://github.com/JoviDeCroock/pracht/commit/d0e8bac992e1abe8562dfe77aa930f901b7b9bf0), [`f3f0234`](https://github.com/JoviDeCroock/pracht/commit/f3f0234bbd3b928ae682a4dbe4610d6b7cca6748), [`8309084`](https://github.com/JoviDeCroock/pracht/commit/830908420b91ac8691fd0335ec449f20ca520680)]:
  - @pracht/core@0.19.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`b42f586`](https://github.com/JoviDeCroock/pracht/commit/b42f5864f2c24935c4b5a43bbb7fd75545dfc079), [`69f1b07`](https://github.com/JoviDeCroock/pracht/commit/69f1b0787de81cc08c7b55a3b10bd0e0ed6bc782), [`3b44c60`](https://github.com/JoviDeCroock/pracht/commit/3b44c600911f7ea734c22e494372376f68611c4f)]:
  - @pracht/core@0.18.0

## 0.3.3

### Patch Changes

- [#368](https://github.com/JoviDeCroock/pracht/pull/368) [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Normalize null-body responses across development and production adapters so an explicit nonzero `Content-Length` cannot leave clients waiting for bytes.

- [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add first-party sessions and pages-router parity for middleware, nested shells, capabilities, and agent configuration, while hardening request cancellation, client navigation, development responses, toolchain requirements, and scaffolded agent tooling. The authoring MCP command is now `pracht dev-mcp`, with `pracht mcp` retained as a deprecated alias.

- [#368](https://github.com/JoviDeCroock/pracht/pull/368) [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add opt-in route CSS inlining across every deployment target and an SSR-safe lazy `useWebVitals()` hook.
- Updated dependencies [[`3a3148b`](https://github.com/JoviDeCroock/pracht/commit/3a3148b2662e62e0bdbf79b7aa170bf0996be4ce), [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b), [`cbe1f4d`](https://github.com/JoviDeCroock/pracht/commit/cbe1f4dd63e009cb73e748c0f8cd36f03b21a842), [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162), [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b), [`0b42d62`](https://github.com/JoviDeCroock/pracht/commit/0b42d622b55757eb73f19c3cff134ee42bfbcf18), [`6ae3d84`](https://github.com/JoviDeCroock/pracht/commit/6ae3d8425fe9760c77a9f9aafc91274bee052c13), [`1a0acb7`](https://github.com/JoviDeCroock/pracht/commit/1a0acb7d619df29bd99d5c8e13a5712fd909262e), [`6684cd8`](https://github.com/JoviDeCroock/pracht/commit/6684cd8356c9112ac933dd20e44464a231e7ad2f), [`27e6b80`](https://github.com/JoviDeCroock/pracht/commit/27e6b806ff1c28a6c2b0d9d94ca23361dea9696e), [`a269447`](https://github.com/JoviDeCroock/pracht/commit/a269447293b39d3bf3e23516318e0365c5ca8258), [`d0ab66e`](https://github.com/JoviDeCroock/pracht/commit/d0ab66ee65c7cb7a6a163f3220b6c668e40717ff)]:
  - @pracht/core@0.17.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`7ebedcb`](https://github.com/JoviDeCroock/pracht/commit/7ebedcbeb79bc216a6609642126ba00a46ef0f9a), [`c341eb4`](https://github.com/JoviDeCroock/pracht/commit/c341eb45703b70adfb18957e55faa5aa99969271), [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`cdffabc`](https://github.com/JoviDeCroock/pracht/commit/cdffabccdf8079cdbe57da2ecd7a11a0f22ad198), [`4ade033`](https://github.com/JoviDeCroock/pracht/commit/4ade03313c7f55b7b61ef3dcd2a9d2af6be188e1), [`32485f4`](https://github.com/JoviDeCroock/pracht/commit/32485f4f1a9199c0f073979fe6124b5159a1aa2b), [`a9bbf4a`](https://github.com/JoviDeCroock/pracht/commit/a9bbf4a6a03b16ca00d6655a340cc27b06b81dc6), [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175), [`2548140`](https://github.com/JoviDeCroock/pracht/commit/2548140ee82fd63e9e1264c042f6a3decd6f107f), [`40d6753`](https://github.com/JoviDeCroock/pracht/commit/40d675347c4725a618bb6e85d4fbe6c35d540cdc)]:
  - @pracht/core@0.16.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069), [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6), [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2), [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f), [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd)]:
  - @pracht/core@0.15.0

## 0.3.0

### Minor Changes

- [#318](https://github.com/JoviDeCroock/pracht/pull/318) [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support Vite `base` — deploying under a sub-path instead of an origin root.
  
  `base: "/my-project/"` now produces a working deploy for a GitHub Pages *project* site, an S3 key prefix, or a reverse-proxy mount. Previously a static export rejected any non-`/` base at build time, because prerendered asset and route-state URLs were root-relative. Adapter-owned development servers serve the base-prefixed client bootstrap and companion endpoints directly, and preserve redirects that their development asset binding has already based.
  
  The base is where the deploy is *served*, not part of the output tree: `dist/client/` still contains `about/index.html`. What changes is every URL the framework emits — `<script src>`, CSS and modulepreload links, `/_pracht/state/…` fetches and preloads, `llms.txt` links, speculation-rules `href_matches` patterns, root-absolute `redirect()` destinations, `apiFetch()` and capability requests (including a `<Form capability>` action attribute), `@pracht/image`'s default optimization endpoint, OpenAPI reference-document links and default server, and hrefs built by `<Link route>`, `href()`, `useNavigate()`, and `prefetch()`. Published Pracht runtime packages are bundled into non-edge SSR builds so Vite applies the configured base consistently outside the monorepo too. Route matching strips the base on both sides (the client router and `handlePrachtRequest`), so manifest route paths stay base-free, while application `Request`/`url` values and `useLocation()` report the URL as the visitor sees it — prerendered documents included, and serverful deployments restore the configured base after a reverse proxy strips it. `pracht dev`, `pracht preview`, and first-party production adapters serve the app under the configured base; devtools and dev-404 links remain inside it, while every host redirects the bare `/my-project` to the query-preserving `/my-project/` form before serving the root document. Anything outside the base remains a 404. Adapter-owned development servers also match base-prefixed requests against the correct route before injecting initial route and shell stylesheets.
  
  Root-absolute strings passed to imperative `prefetch()` remain base-free route paths and receive the configured deploy base before matching and fetching. Absolute and protocol-relative URLs keep their existing URL semantics.
  
  `withBase()`, `stripBase()`, and `PRACHT_BASE` are exported from `@pracht/core` for URLs you build yourself.
  
  Two deliberate boundaries:
  
  - Hand-written root-absolute links are not rewritten. `<a href="/about">` means the origin root in HTML, matching Next's `basePath` and SvelteKit's `base`; use `<Link route="about">` or `href("about")` for internal navigation. A same-origin link outside the base is handed to the browser instead of matched as a route.
  - A cross-origin base (`https://cdn.example.com/`, or protocol-relative `//cdn…`) stays a static-export build error. It relocates only assets while documents and the route-state tree remain at the origin root, and a static export serves all three from one deploy root. Document-relative bases (`""` and `"./"`) are rejected too because their asset URLs resolve beneath each nested prerendered page directory; use a root-absolute path base instead.
  - A root-absolute base must contain safe URL segments. Repeated slashes, malformed escapes, and segments that decode to a path separator, `.`, `..`, NUL, or another control character are rejected. Percent-equivalent spellings match canonically at runtime. Static validation also retains document-relative bases supplied by companion Vite plugins so SSR normalization cannot hide them.
  
  A sub-path base is wired end to end for static exports. Serverful adapters emit the same base-carrying URLs and strip the base before route matching. The Node adapter maps a retained public base onto its base-free static-file and ISG-manifest keys; when a trusted proxy strips the base before forwarding instead, declare that rewrite with `nodeAdapter({ basePathStripped: true })`. The explicit contract prevents a route whose first segment matches the base from being stripped twice, including a route equal to the base segment itself. In stripped mode the proxy owns the public bare-base redirect because the upstream cannot distinguish it from that legitimate route.
  
  Cloudflare keeps asset-binding redirects and Workers Caching purge paths inside the public base. Netlify bundles the base-free client tree when its static layer cannot map base-prefixed URLs onto it, including files whose literal origin-root URLs use a custom function bypass. Unsafe root-absolute bases now fail during Vite config resolution for every adapter, and dev error-overlay editor requests use the configured base.
  
  With the default base of `/`, `withBase()` and `stripBase()` are the identity and output is byte-for-byte unchanged.

### Patch Changes

- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0

## 0.2.9

### Patch Changes

- [#292](https://github.com/JoviDeCroock/pracht/pull/292) [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Close the findings of the 2026-08-11 framework permutation audit.
  
  **Vercel ISG webhook revalidation could never authenticate.** The adapter read
  `PRACHT_REVALIDATE_TOKEN` through a `globalThis.process.env` alias; the package
  bundler inlined that single-use alias, and the *app* build's `process.env`
  define then collapsed it to `return {}[PRACHT_REVALIDATE_TOKEN_ENV]`. Every
  `POST /__pracht/revalidate` answered `401` regardless of configuration, on both
  the Edge render function and the Node ISG launcher. The read now goes through
  `serverEnv` via a new `resolveRevalidationToken()` in `@pracht/core`, which all
  three adapters share, and the Vercel build E2E asserts both the absence of
  collapsed env reads in the emitted bundle and a working authenticated request —
  unit tests against `src/` could not catch a defect the build introduced.
  
  **A uniform default `Cache-Control` across adapters.** `preventHeuristicCaching`
  moved from `@pracht/adapter-cloudflare` into `@pracht/core` and now runs on Node
  and Vercel too, so `GET`/`HEAD` responses with no caching policy get
  `private, no-cache` on every adapter. A shared cache in front of the origin may
  otherwise apply heuristic freshness to an authenticated SSR page, and `Cookie` is
  not part of its cache key. Previously an app hardened on Cloudflare lost the
  protection when it moved to Node or Vercel. Any CDN-targeted policy the app sets
  itself — including the vendor-neutral `CDN-Cache-Control` — suppresses the
  default, and ISG document responses are exempt on every adapter so a route's
  caching headers do not depend on whether its snapshot exists yet.
  
  **A Web Bot Auth signer.** `@pracht/core/agent-auth` is a new entry point
  exporting `signAgentRequest()`, `createAgentSignatureHeaders()`, and
  `generateAgentKeyPair()` — the RFC 9421 signing side the framework verified but
  never shipped. `pracht eval` scenarios gain a `signAs` block (and per-step
  `"sign": false`), so a capability declaring `agentPolicy: "require"` is finally
  reachable from the framework's own agent-task harness rather than only from
  Playwright.
  
  **Revalidation webhooks explain themselves.** `POST /__pracht/revalidate` adds a
  `details` array naming why each path was skipped (`not_a_route`, `not_isg`,
  `not_prerendered`, `no_webhook_policy`) or failed. The three existing path
  arrays are unchanged. All three adapters now build the response through one
  shared `RevalidationReport`.
  
  **llms.txt no longer advertises framework plumbing.** Paths containing a
  `_pracht` or `__pracht` segment — such as the `@pracht/image` endpoint at
  `/api/_pracht/image` — are excluded from the generated index by default. A build
  that would overwrite a hand-authored `public/llms.txt` now warns instead of
  discarding it silently, and `pracht llms` gains `--out` plus a note about the
  two unrelated documents that share the name.
  
  **Verification and scaffolding.** `pracht verify` warns when a Cloudflare app's
  assets binding leaves `html_handling` at a default that 307-redirects every
  prerendered route, and reports when no `.pracht/app-graph.json` snapshot exists
  rather than staying silent. `create-pracht` points `.mcp.json` at the project's
  own CLI (`npx --no-install pracht mcp`) instead of the registry's latest, names
  the pages router's manifest-only tradeoffs at the router prompt, and documents
  in `--help` that `--template` and `--tailwind` set the same thing (last one
  wins).

- [#291](https://github.com/JoviDeCroock/pracht/pull/291) [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep WebMCP tools available on islands-mode responses that render no UI islands, while preserving zero-JavaScript `hydration: "none"` routes and carrying the requirement safely through built-in adapters and prerendering.
  
  Add fail-closed pages-router ISG time policies through `export const REVALIDATE = seconds`, harden static discovery against comments, strings, Markdown fences, shell misuse, and ambiguous config, teach generation, build, doctor, verify, docs, and skills the contract, and align generated human documentation with agent guidance about pages-router limitations.

- [#277](https://github.com/JoviDeCroock/pracht/pull/277) [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Render Vercel and Cloudflare Workers Caching ISG routes on a sanitized request so a cache miss cannot store a personalized page.
  
  Vercel's prerender functions were invoked with a faithful copy of the visitor's
  request, so loaders saw that visitor's `Cookie` and `Authorization` headers while
  producing HTML that Vercel stores in the ISR cache (keyed on the path alone) and
  replays to everyone else. `createVercelNodeListener` now renders on the same
  sanitized ISG request the Node and Cloudflare regeneration paths use — `GET`,
  `Accept: text/html`, path only, no query string or body — and strips credential
  headers (`Set-Cookie`, `Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`,
  secret-shaped `x-*`) from the response before Vercel caches it, matching what
  build-time prerendering already refuses to emit. Responses that mark themselves
  uncacheable are logged, since Vercel's prerender cache stores them regardless.
  
  Cloudflare Workers Caching cold and stale renders now use the same sanitized
  request as the worker-managed Cache API regeneration path before calling
  `createContext`, middleware, or loaders. Query strings still participate in the
  edge cache key, but they cannot influence the shared response that application
  code renders; markdown-capable routes retain a canonical `text/markdown`
  variant without forwarding the visitor's raw `Accept` value.
  
  `createISGRegenerationRequest(pathname, base)` now accepts a `URL` or absolute
  URL string as its base in addition to a `Request`, and `@pracht/core` exports
  `isDangerousPrerenderHeader` plus the server-side `prefersMarkdown` negotiation
  helper for adapters that write into a shared cache.

- [#272](https://github.com/JoviDeCroock/pracht/pull/272) [`46c9fa1`](https://github.com/JoviDeCroock/pracht/commit/46c9fa17a5b92d06ede98a2f0ffaaadc0869b11d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix `vercel deploy --prebuilt` failing with `Unexpected function type "EdgeFunction"` for ISG routes.
  
  Vercel only supports ISR on Serverless Functions, but the build paired each
  `<route>.prerender-config.json` with the edge function, so any app with an ISG
  route produced an output Vercel refused to deploy. ISG routes are now emitted as
  Node Serverless Functions while the main handler stays on the edge; both load
  the same Web-API-only server bundle. Generated Vercel entries export a
  `nodeListener` (`createVercelNodeListener(handle)`) for those functions to use,
  and a custom server entry that omits it now fails the build with a descriptive
  error instead of at request time. The Node listener exposes a compatible
  `waitUntil()` context, and Edge's `regions: "all"` sentinel is omitted from Node
  function configs so they use the project's default Serverless region.
- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0

## 0.2.8

### Patch Changes

- Updated dependencies [[`6a84a27`](https://github.com/JoviDeCroock/pracht/commit/6a84a27203f7a8f7d440030d8583c6306fd6ed9c)]:
  - @pracht/core@0.12.0

## 0.2.7

### Patch Changes

- Updated dependencies [[`aa32069`](https://github.com/JoviDeCroock/pracht/commit/aa320692339c1d1a7d4d4cd9467be113472d271d)]:
  - @pracht/core@0.11.4

## 0.2.6

### Patch Changes

- Updated dependencies []:
  - @pracht/core@0.11.3

## 0.2.5

### Patch Changes

- Updated dependencies [[`fcc5e67`](https://github.com/JoviDeCroock/pracht/commit/fcc5e678feec745dd7e7b7fd295bad25eb16701a)]:
  - @pracht/core@0.11.2

## 0.2.4

### Patch Changes

- Updated dependencies [[`b367a1b`](https://github.com/JoviDeCroock/pracht/commit/b367a1bb5048f87c2201fdcacb8ec83df4a93eaa), [`dc568a4`](https://github.com/JoviDeCroock/pracht/commit/dc568a438b40de43a61ad6674fe8f934e727af00)]:
  - @pracht/core@0.11.1

## 0.2.3

### Patch Changes

- Updated dependencies [[`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3)]:
  - @pracht/core@0.11.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`7cdfa59`](https://github.com/JoviDeCroock/pracht/commit/7cdfa59405da539cf9e10c9f3319d204fd46e8f8)]:
  - @pracht/core@0.10.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`1aed2e5`](https://github.com/JoviDeCroock/pracht/commit/1aed2e5be5b447a11fb19ad89b7646cb8470bed0)]:
  - @pracht/core@0.10.1

## 0.2.0

### Minor Changes

- [#172](https://github.com/JoviDeCroock/pracht/pull/172) [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add webhook ISG revalidation policies and the shared `/__pracht/revalidate`
  endpoint contract. Node regenerates on-disk ISG HTML, Cloudflare stores runtime
  ISG responses in the Workers Cache API with `env.ASSETS` fallback, and Vercel
  emits native Build Output API prerender functions with on-demand ISR wiring.

  ISG regeneration is single-flighted per path (a stampede of stale requests or
  webhook posts shares one render instead of racing N parallel regenerations),
  and the webhook endpoint reports a `failed` array alongside `revalidated` and
  `skipped`: regeneration errors keep the previously generated copy live and no
  longer abort the batch with a 500. `@pracht/core` exports the new
  `createRevalidationSingleFlight()` and `isCacheableISGResponse()` helpers for
  adapters, and Cloudflare ISG responses served from the Cache API now carry
  `Vary: x-pracht-route-state-request` like asset-served responses.

### Patch Changes

- [#217](https://github.com/JoviDeCroock/pracht/pull/217) [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Limit webhook revalidation requests to 64 paths and keep malformed Node or
  Cloudflare manifest entries isolated to their individual batch result.
- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`7342039`](https://github.com/JoviDeCroock/pracht/commit/7342039ed530f4a1c2321ae6c3924dfa9fd491b9), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f), [`f044aca`](https://github.com/JoviDeCroock/pracht/commit/f044acad9874585aa1cc5c5133cb18ef253f1761)]:
  - @pracht/core@0.10.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`d27b96a`](https://github.com/JoviDeCroock/pracht/commit/d27b96a68354b69d06cdfdd9667956631283ce1a), [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072), [`54b1070`](https://github.com/JoviDeCroock/pracht/commit/54b1070e3c73075689ae7d40ceb7716da412e077), [`a6b120b`](https://github.com/JoviDeCroock/pracht/commit/a6b120b8b79082adbdb54dbeb1920ba3703079c8), [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9), [`c1b22c4`](https://github.com/JoviDeCroock/pracht/commit/c1b22c4e786a485c969143de48cd2be7f5f03fe8)]:
  - @pracht/core@0.9.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`9b089c6`](https://github.com/JoviDeCroock/pracht/commit/9b089c65a51ff724737fffce18f6b08259cfb76e), [`a1c44ab`](https://github.com/JoviDeCroock/pracht/commit/a1c44ab966bcf1afafc33d26d846a1f91a15011e), [`c656bbd`](https://github.com/JoviDeCroock/pracht/commit/c656bbd622f73567f38c02e4346039d2595568b7), [`b3be9a0`](https://github.com/JoviDeCroock/pracht/commit/b3be9a0563f3f66df1f18cc91929b9191b834646)]:
  - @pracht/core@0.8.1

## 0.1.3

### Patch Changes

- [#150](https://github.com/JoviDeCroock/pracht/pull/150) [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reduce the default browser bootstrap by adding lean core client/manifest entries,
  resolving browser route imports through a client-safe core entry, and loading
  prefetch listener setup after the router initializes. Adapters now point
  generated server entries at `@pracht/core/server` so edge worker builds do not
  resolve server imports through the browser condition.
- Updated dependencies [[`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`51d0de1`](https://github.com/JoviDeCroock/pracht/commit/51d0de12bcda8a1cadd3749f56f03bac2e95c3a6), [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c)]:
  - @pracht/core@0.8.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c), [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b), [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca)]:
  - @pracht/core@0.7.0

## 0.1.1

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

- Updated dependencies [[`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6)]:
  - @pracht/core@0.6.1

## 0.1.0

### Minor Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

### Patch Changes

- Updated dependencies [[`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac), [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d)]:
  - @pracht/core@0.6.0

## 0.0.13

### Patch Changes

- Updated dependencies [[`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e), [`49d6348`](https://github.com/JoviDeCroock/pracht/commit/49d6348bc984464cdb0e8c54c5ef9ba5cdec911e)]:
  - @pracht/core@0.5.0

## 0.0.12

### Patch Changes

- Updated dependencies [[`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081)]:
  - @pracht/core@0.4.0

## 0.0.11

### Patch Changes

- [#120](https://github.com/JoviDeCroock/pracht/pull/120) [`92e5f73`](https://github.com/JoviDeCroock/pracht/commit/92e5f7346d37138957ee44ae9f315185e0b22e03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an `edge` flag to `PrachtAdapter`. Adapters that target edge runtimes (where `node_modules` cannot be resolved at runtime) set `edge: true`, and the Vite plugin reads it to enable `ssr.noExternal` for SSR builds. The built-in Cloudflare and Vercel adapters opt in; custom edge adapters can do the same instead of the plugin hard-coding adapter ids.

- Updated dependencies [[`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7), [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42), [`901ef5b`](https://github.com/JoviDeCroock/pracht/commit/901ef5b7958e4066d5382f836d098bded8bfe320), [`015e987`](https://github.com/JoviDeCroock/pracht/commit/015e987a2de471980fab557e3dbf3d52937ad0ac)]:
  - @pracht/core@0.3.0

## 0.0.10

### Patch Changes

- Updated dependencies [[`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4), [`49732fc`](https://github.com/JoviDeCroock/pracht/commit/49732fc78a776cbaabe9579e5a7f2fb154497479), [`d88c9e4`](https://github.com/JoviDeCroock/pracht/commit/d88c9e4b8347c4d3ecacdbc5f7674ee38af0092e), [`7ee2a93`](https://github.com/JoviDeCroock/pracht/commit/7ee2a936357a0f0b4ff7f5a7f6f3206b070f3890), [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e), [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4)]:
  - @pracht/core@0.2.7

## 0.0.9

### Patch Changes

- Updated dependencies [[`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f), [`d284596`](https://github.com/JoviDeCroock/pracht/commit/d284596fe00c3c74d56e7dc040ea1e8c9961eb99), [`2c95189`](https://github.com/JoviDeCroock/pracht/commit/2c95189209b4b09f862194078f7d2ced15f22dde)]:
  - @pracht/core@0.2.6

## 0.0.8

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

- Updated dependencies [[`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e)]:
  - @pracht/core@0.2.5

## 0.0.7

### Patch Changes

- Updated dependencies [[`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257)]:
  - @pracht/core@0.2.4

## 0.0.6

### Patch Changes

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3

## 0.0.5

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2

## 0.0.4

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1

## 0.0.3

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0

## 0.0.2

### Patch Changes

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option

- Updated dependencies [[`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308), [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc)]:
  - @pracht/core@0.0.1
