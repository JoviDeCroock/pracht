---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/adapter-static": minor
"@pracht/cli": minor
---

Support Vite `base` — deploying under a sub-path instead of an origin root.

`base: "/my-project/"` now produces a working deploy for a GitHub Pages *project* site, an S3 key prefix, or a reverse-proxy mount. Previously a static export rejected any non-`/` base at build time, because prerendered asset and route-state URLs were root-relative.

The base is where the deploy is *served*, not part of the output tree: `dist/client/` still contains `about/index.html`. What changes is every URL the framework emits — `<script src>`, CSS and modulepreload links, `/_pracht/state/…` fetches and preloads, `llms.txt` links, speculation-rules `href_matches` patterns, `apiFetch()` and capability requests (including a `<Form capability>` action attribute), and hrefs built by `<Link route>`, `href()`, `useNavigate()`, and `prefetch()`. Route matching strips the base on both sides (the client router and `handlePrachtRequest`), so manifest route paths stay base-free, while `useLocation()` reports the URL as the visitor sees it — prerendered documents included, so a first paint agrees with the URL a later client-side navigation commits. `pracht dev` and `pracht preview` both serve the app under the configured base, the latter redirecting the bare `/my-project` and answering anything outside it with a 404.

`withBase()`, `stripBase()`, and `PRACHT_BASE` are exported from `@pracht/core` for URLs you build yourself.

Two deliberate boundaries:

- Hand-written root-absolute links are not rewritten. `<a href="/about">` means the origin root in HTML, matching Next's `basePath` and SvelteKit's `base`; use `<Link route="about">` or `href("about")` for internal navigation. A same-origin link outside the base is handed to the browser instead of matched as a route.
- A cross-origin base (`https://cdn.example.com/`, or protocol-relative `//cdn…`) stays a static-export build error. It relocates only assets while documents and the route-state tree remain at the origin root, and a static export serves all three from one deploy root. Document-relative bases (`""` and `"./"`) are rejected too because their asset URLs resolve beneath each nested prerendered page directory; use a root-absolute path base instead.

A sub-path base is wired end to end for static exports. Serverful adapters emit the same base-carrying URLs and strip the base before route matching, but their static-file and ISG-manifest lookups are still keyed by origin-root paths — mount those behind a proxy that strips the base before forwarding.

With the default base of `/`, `withBase()` and `stripBase()` are the identity and output is byte-for-byte unchanged.
